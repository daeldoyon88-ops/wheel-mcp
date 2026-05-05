import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_JSON_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.json");
const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

function createEmptyJournal() {
  return {
    version: "1.0",
    updatedAt: null,
    records: [],
  };
}

function toIntBool(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function toInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toReal(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRecordToRow(record, nowIso = new Date().toISOString()) {
  const source = record?.source ?? {};
  const ranks = record?.ranks ?? {};
  const scores = record?.scores ?? {};
  const underlying = record?.underlying ?? {};
  const strike = record?.strike ?? {};
  const context = record?.context ?? {};
  const resolution = record?.resolution ?? {};
  return {
    id: String(record?.id ?? "").trim(),
    scanSessionId: record?.scanSessionId ?? null,
    scanTimestamp: record?.scanTimestamp ?? null,
    scanDate: record?.scanDate ?? null,
    selectedExpiration: record?.selectedExpiration ?? null,
    expiration: record?.expiration ?? null,
    expirationCohort: record?.expirationCohort ?? null,
    dteAtScan: toInt(record?.dteAtScan),
    candidateRank: toInt(record?.candidateRank),
    captureSource: record?.captureSource ?? null,
    symbol: record?.symbol ?? null,
    strikeMode: record?.strikeMode ?? null,
    yahooValidated: toIntBool(source?.yahoo),
    ibkrValidated: toIntBool(source?.ibkrValidated),
    yahooRank: toInt(ranks?.yahooRank),
    ibkrRank: toInt(ranks?.ibkrRank),
    qualityScoreYahoo: toReal(scores?.qualityScoreYahoo),
    finalScoreYahoo: toReal(scores?.finalScoreYahoo),
    eliteScore: toReal(scores?.eliteScore),
    eliteBadge: scores?.eliteBadge ?? null,
    spotAtScan: toReal(underlying?.spotAtScan),
    expectedMove: toReal(underlying?.expectedMove),
    lowerBound: toReal(underlying?.lowerBound),
    strike: toReal(strike?.strike),
    premium: toReal(strike?.premium),
    bid: toReal(strike?.bid),
    ask: toReal(strike?.ask),
    mid: toReal(strike?.mid),
    spread: toReal(strike?.spread),
    spreadPct: toReal(strike?.spreadPct),
    annualizedYield: toReal(strike?.annualizedYield),
    targetPremium: toReal(strike?.targetPremium),
    popEstimate: toReal(strike?.popEstimate),
    support: toReal(context?.support),
    resistance: toReal(context?.resistance),
    supportStatus: context?.supportStatus ?? null,
    hasEarningsBeforeExpiration: toIntBool(context?.hasEarningsBeforeExpiration),
    earningsDate: context?.earningsDate ?? null,
    earningsDaysUntil: toInt(context?.earningsDaysUntil),
    rsi: toReal(context?.rsi),
    resolved: toIntBool(resolution?.resolved),
    expirationClosePrice: toReal(resolution?.expirationClosePrice),
    expiredWorthless: toIntBool(resolution?.expiredWorthless),
    assigned: toIntBool(resolution?.assigned),
    rolled: toIntBool(resolution?.rolled),
    realizedPl: toReal(resolution?.realizedPl),
    premiumRealized: toReal(resolution?.premiumRealized),
    popPredictionCorrect: toIntBool(resolution?.popPredictionCorrect),
    outcomeStatus: resolution?.outcomeStatus ?? null,
    resolutionDate: resolution?.resolutionDate ?? null,
    notes: resolution?.notes ?? null,
    rawJson: JSON.stringify(record ?? {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function createWheelValidationStoreSqlite(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const jsonPath = options.jsonPath ?? DEFAULT_JSON_PATH;
  let db = null;
  let initialized = false;

  async function ensureParentDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  function ensureDbSync() {
    if (db) return db;
    db = new DatabaseSync(sqlitePath);
    return db;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await ensureParentDir(sqlitePath);
    const conn = ensureDbSync();
    conn.exec(`
      CREATE TABLE IF NOT EXISTS wheel_validation_records (
        id TEXT PRIMARY KEY,
        scanSessionId TEXT,
        scanTimestamp TEXT,
        scanDate TEXT,
        selectedExpiration TEXT,
        expiration TEXT,
        expirationCohort TEXT,
        dteAtScan INTEGER,
        candidateRank INTEGER,
        captureSource TEXT,
        symbol TEXT,
        strikeMode TEXT,
        yahooValidated INTEGER,
        ibkrValidated INTEGER,
        yahooRank INTEGER,
        ibkrRank INTEGER,
        qualityScoreYahoo REAL,
        finalScoreYahoo REAL,
        eliteScore REAL,
        eliteBadge TEXT,
        spotAtScan REAL,
        expectedMove REAL,
        lowerBound REAL,
        strike REAL,
        premium REAL,
        bid REAL,
        ask REAL,
        mid REAL,
        spread REAL,
        spreadPct REAL,
        annualizedYield REAL,
        targetPremium REAL,
        popEstimate REAL,
        support REAL,
        resistance REAL,
        supportStatus TEXT,
        hasEarningsBeforeExpiration INTEGER,
        earningsDate TEXT,
        earningsDaysUntil INTEGER,
        rsi REAL,
        resolved INTEGER,
        expirationClosePrice REAL,
        expiredWorthless INTEGER,
        assigned INTEGER,
        rolled INTEGER,
        realizedPl REAL,
        premiumRealized REAL,
        popPredictionCorrect INTEGER,
        outcomeStatus TEXT,
        resolutionDate TEXT,
        notes TEXT,
        rawJson TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wvr_symbol ON wheel_validation_records(symbol);
      CREATE INDEX IF NOT EXISTS idx_wvr_expiration ON wheel_validation_records(expiration);
      CREATE INDEX IF NOT EXISTS idx_wvr_expirationCohort ON wheel_validation_records(expirationCohort);
      CREATE INDEX IF NOT EXISTS idx_wvr_dteAtScan ON wheel_validation_records(dteAtScan);
      CREATE INDEX IF NOT EXISTS idx_wvr_resolved ON wheel_validation_records(resolved);
      CREATE INDEX IF NOT EXISTS idx_wvr_strikeMode ON wheel_validation_records(strikeMode);
      CREATE INDEX IF NOT EXISTS idx_wvr_eliteBadge ON wheel_validation_records(eliteBadge);
      CREATE INDEX IF NOT EXISTS idx_wvr_scanDate ON wheel_validation_records(scanDate);
      CREATE INDEX IF NOT EXISTS idx_wvr_scanSessionId ON wheel_validation_records(scanSessionId);
    `);

    const insertStmt = conn.prepare(`
      INSERT INTO wheel_validation_records (
        id, scanSessionId, scanTimestamp, scanDate, selectedExpiration, expiration, expirationCohort,
        dteAtScan, candidateRank, captureSource, symbol, strikeMode, yahooValidated, ibkrValidated,
        yahooRank, ibkrRank, qualityScoreYahoo, finalScoreYahoo, eliteScore, eliteBadge, spotAtScan,
        expectedMove, lowerBound, strike, premium, bid, ask, mid, spread, spreadPct, annualizedYield,
        targetPremium, popEstimate, support, resistance, supportStatus, hasEarningsBeforeExpiration,
        earningsDate, earningsDaysUntil, rsi, resolved, expirationClosePrice, expiredWorthless, assigned,
        rolled, realizedPl, premiumRealized, popPredictionCorrect, outcomeStatus, resolutionDate, notes,
        rawJson, createdAt, updatedAt
      ) VALUES (
        @id, @scanSessionId, @scanTimestamp, @scanDate, @selectedExpiration, @expiration, @expirationCohort,
        @dteAtScan, @candidateRank, @captureSource, @symbol, @strikeMode, @yahooValidated, @ibkrValidated,
        @yahooRank, @ibkrRank, @qualityScoreYahoo, @finalScoreYahoo, @eliteScore, @eliteBadge, @spotAtScan,
        @expectedMove, @lowerBound, @strike, @premium, @bid, @ask, @mid, @spread, @spreadPct, @annualizedYield,
        @targetPremium, @popEstimate, @support, @resistance, @supportStatus, @hasEarningsBeforeExpiration,
        @earningsDate, @earningsDaysUntil, @rsi, @resolved, @expirationClosePrice, @expiredWorthless, @assigned,
        @rolled, @realizedPl, @premiumRealized, @popPredictionCorrect, @outcomeStatus, @resolutionDate, @notes,
        @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO NOTHING
    `);

    let imported = 0;
    let ignored = 0;
    try {
      const raw = await fs.readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records) {
        const row = normalizeRecordToRow(record);
        if (!row.id) {
          ignored += 1;
          continue;
        }
        const result = insertStmt.run(row);
        if (Number(result?.changes ?? 0) > 0) imported += 1;
        else ignored += 1;
      }
      if (records.length > 0) {
        console.log(`[wheel-journal-sqlite] json migration imported=${imported} ignored=${ignored}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    initialized = true;
  }

  async function load() {
    await ensureInitialized();
    const conn = ensureDbSync();
    const rows = conn
      .prepare("SELECT id, rawJson, updatedAt FROM wheel_validation_records ORDER BY scanTimestamp DESC, id DESC")
      .all();
    const records = rows
      .map((row) => {
        try {
          const parsed = JSON.parse(String(row?.rawJson ?? "{}"));
          if (!parsed || typeof parsed !== "object") return null;
          if (!parsed.id) parsed.id = row.id;
          return parsed;
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
    const updatedAtRow = conn
      .prepare("SELECT MAX(updatedAt) AS updatedAt FROM wheel_validation_records")
      .get();
    return {
      version: "1.0",
      updatedAt: updatedAtRow?.updatedAt ?? null,
      records,
    };
  }

  async function save(journal) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const nowIso = new Date().toISOString();
    const upsert = conn.prepare(`
      INSERT INTO wheel_validation_records (
        id, scanSessionId, scanTimestamp, scanDate, selectedExpiration, expiration, expirationCohort,
        dteAtScan, candidateRank, captureSource, symbol, strikeMode, yahooValidated, ibkrValidated,
        yahooRank, ibkrRank, qualityScoreYahoo, finalScoreYahoo, eliteScore, eliteBadge, spotAtScan,
        expectedMove, lowerBound, strike, premium, bid, ask, mid, spread, spreadPct, annualizedYield,
        targetPremium, popEstimate, support, resistance, supportStatus, hasEarningsBeforeExpiration,
        earningsDate, earningsDaysUntil, rsi, resolved, expirationClosePrice, expiredWorthless, assigned,
        rolled, realizedPl, premiumRealized, popPredictionCorrect, outcomeStatus, resolutionDate, notes,
        rawJson, createdAt, updatedAt
      ) VALUES (
        @id, @scanSessionId, @scanTimestamp, @scanDate, @selectedExpiration, @expiration, @expirationCohort,
        @dteAtScan, @candidateRank, @captureSource, @symbol, @strikeMode, @yahooValidated, @ibkrValidated,
        @yahooRank, @ibkrRank, @qualityScoreYahoo, @finalScoreYahoo, @eliteScore, @eliteBadge, @spotAtScan,
        @expectedMove, @lowerBound, @strike, @premium, @bid, @ask, @mid, @spread, @spreadPct, @annualizedYield,
        @targetPremium, @popEstimate, @support, @resistance, @supportStatus, @hasEarningsBeforeExpiration,
        @earningsDate, @earningsDaysUntil, @rsi, @resolved, @expirationClosePrice, @expiredWorthless, @assigned,
        @rolled, @realizedPl, @premiumRealized, @popPredictionCorrect, @outcomeStatus, @resolutionDate, @notes,
        @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        scanSessionId=excluded.scanSessionId,
        scanTimestamp=excluded.scanTimestamp,
        scanDate=excluded.scanDate,
        selectedExpiration=excluded.selectedExpiration,
        expiration=excluded.expiration,
        expirationCohort=excluded.expirationCohort,
        dteAtScan=excluded.dteAtScan,
        candidateRank=excluded.candidateRank,
        captureSource=excluded.captureSource,
        symbol=excluded.symbol,
        strikeMode=excluded.strikeMode,
        yahooValidated=excluded.yahooValidated,
        ibkrValidated=excluded.ibkrValidated,
        yahooRank=excluded.yahooRank,
        ibkrRank=excluded.ibkrRank,
        qualityScoreYahoo=excluded.qualityScoreYahoo,
        finalScoreYahoo=excluded.finalScoreYahoo,
        eliteScore=excluded.eliteScore,
        eliteBadge=excluded.eliteBadge,
        spotAtScan=excluded.spotAtScan,
        expectedMove=excluded.expectedMove,
        lowerBound=excluded.lowerBound,
        strike=excluded.strike,
        premium=excluded.premium,
        bid=excluded.bid,
        ask=excluded.ask,
        mid=excluded.mid,
        spread=excluded.spread,
        spreadPct=excluded.spreadPct,
        annualizedYield=excluded.annualizedYield,
        targetPremium=excluded.targetPremium,
        popEstimate=excluded.popEstimate,
        support=excluded.support,
        resistance=excluded.resistance,
        supportStatus=excluded.supportStatus,
        hasEarningsBeforeExpiration=excluded.hasEarningsBeforeExpiration,
        earningsDate=excluded.earningsDate,
        earningsDaysUntil=excluded.earningsDaysUntil,
        rsi=excluded.rsi,
        resolved=excluded.resolved,
        expirationClosePrice=excluded.expirationClosePrice,
        expiredWorthless=excluded.expiredWorthless,
        assigned=excluded.assigned,
        rolled=excluded.rolled,
        realizedPl=excluded.realizedPl,
        premiumRealized=excluded.premiumRealized,
        popPredictionCorrect=excluded.popPredictionCorrect,
        outcomeStatus=excluded.outcomeStatus,
        resolutionDate=excluded.resolutionDate,
        notes=excluded.notes,
        rawJson=excluded.rawJson,
        createdAt=COALESCE(wheel_validation_records.createdAt, excluded.createdAt),
        updatedAt=excluded.updatedAt
    `);
    const tx = conn.transaction((items) => {
      for (const record of items) {
        const row = normalizeRecordToRow(record, nowIso);
        if (!row.id) continue;
        upsert.run(row);
      }
    });
    tx(records);
    return {
      version: journal?.version ?? "1.0",
      updatedAt: journal?.updatedAt ?? nowIso,
      records,
    };
  }

  return {
    load,
    save,
    sqlitePath,
    jsonPath,
  };
}
