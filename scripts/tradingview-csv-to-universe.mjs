/**
 * Convertit un export CSV TradingView en universe.*.json
 * (tableau de { symbol, enabled }).
 *
 * Usage (CMD) :
 *   node scripts\tradingview-csv-to-universe.mjs <entrée.csv> <sortie.json>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HEADER_NAMES = new Set(["symbol", "ticker", "tickers", "name"]);

function normalizeSymbol(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // Guillemets CSV
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Préfixe marché type NYSE: / NASDAQ: / OTCMKTS: / AMEX: etc.
  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    const left = s.slice(0, colon);
    if (/^[A-Z0-9._-]+$/i.test(left) && left.length <= 12) {
      s = s.slice(colon + 1).trim();
    }
  }
  return s.toUpperCase();
}

function looksLikeHeader(cell) {
  const t = String(cell).trim().toLowerCase();
  return HEADER_NAMES.has(t) || t === "";
}

function parseLine(line) {
  // Première colonne (séparateur virgule ou point-virgule)
  const sep = line.includes(";") && !line.includes(",") ? ";" : ",";
  const first = line.split(sep)[0]?.trim() ?? "";
  return first;
}

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Usage: node scripts\\tradingview-csv-to-universe.mjs <entrée.csv> <sortie.json>");
    process.exit(1);
  }

  const absIn = resolve(inPath);
  const absOut = resolve(outPath);

  const text = readFileSync(absIn, "utf8");
  const lines = text.split(/\r?\n/);

  const seen = new Set();
  const rows = [];

  let firstDataLine = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cell = parseLine(trimmed);
    if (firstDataLine && looksLikeHeader(cell)) {
      firstDataLine = false;
      continue;
    }
    firstDataLine = false;

    const sym = normalizeSymbol(cell);
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    rows.push({ symbol: sym, enabled: true });
  }

  const json = JSON.stringify(rows, null, 2) + "\n";
  writeFileSync(absOut, json, "utf8");

  console.log(`Lu: ${absIn}`);
  console.log(`Écrit: ${absOut}`);
  console.log(`Symboles uniques: ${rows.length}`);
}

main();
