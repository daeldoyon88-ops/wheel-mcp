// fetchTeclCache.mjs
// Récupère l'historique OHLC journalier de TECL depuis Yahoo et l'écrit dans
// debug/ohlc-cache-TECL.json AU MÊME FORMAT que les autres caches du repo
// (compatible avec loadRows() de pineEngine.mjs).
//
// PORTÉE : TradingView / Pine / audit TECL uniquement. Aucun git add, aucun commit.
// AUDIT_INSECURE_TLS=1 si erreur certificat Yahoo sur Windows.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DEBUG_DIR = path.join(ROOT, "debug");
const OUT = path.join(DEBUG_DIR, "ohlc-cache-TECL.json");
const SYMBOL = process.argv[2] || "TECL";
const START_DATE = new Date("2008-01-02T00:00:00Z");

if (process.env.AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("⚠ AUDIT_INSECURE_TLS=1 — vérification TLS désactivée pour ce fetch uniquement.");
}

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(q) {
  const close = toNum(q.close);
  if (!Number.isFinite(close) || close <= 0) return null;
  const date = q.date instanceof Date ? q.date : new Date(q.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: date.toISOString(),
    open: toNum(q.open) ?? close,
    high: toNum(q.high) ?? close,
    low: toNum(q.low) ?? close,
    close,
    volume: toNum(q.volume),
  };
}

const res = await yahoo.chart(SYMBOL, { period1: START_DATE, period2: new Date(), interval: "1d" });
const quotes = res?.quotes;
if (!Array.isArray(quotes) || quotes.length === 0) {
  console.error(`Aucune donnée Yahoo pour ${SYMBOL}.`);
  process.exit(2);
}
const rows = quotes.map(normalize).filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date));
if (rows.length < 50) {
  console.error(`Trop peu de barres (${rows.length}) pour ${SYMBOL}.`);
  process.exit(2);
}

const payload = { symbol: SYMBOL, savedAt: new Date().toISOString(), rows };
fs.writeFileSync(OUT, JSON.stringify(payload), "utf8");
console.log(`✅ ${SYMBOL} : ${rows.length} barres ${rows[0].date.slice(0, 10)} → ${rows[rows.length - 1].date.slice(0, 10)}`);
console.log(`Écrit : ${path.relative(ROOT, OUT)}`);
