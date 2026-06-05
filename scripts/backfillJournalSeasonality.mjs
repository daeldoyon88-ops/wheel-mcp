#!/usr/bin/env node
/**
 * CLI — Backfill saisonnalité Journal POP (CACHE-ONLY, dry-run par défaut).
 *
 * Remplit les 7 colonnes seasonality_* des records historiques dont le ticker
 * existe déjà dans le cache `seasonality_cache`. Lecture cache seule : AUCUN
 * appel Yahoo, AUCUN fetch réseau, AUCUN calcul de saisonnalité manquante.
 *
 * Usage :
 *   node scripts/backfillJournalSeasonality.mjs               # dry-run (défaut)
 *   node scripts/backfillJournalSeasonality.mjs --write       # applique les UPDATE
 *   node scripts/backfillJournalSeasonality.mjs --limit=10    # max 10 tickers
 *   node scripts/backfillJournalSeasonality.mjs --symbols=TQQQ,SOFI
 */

import { runJournalSeasonalityBackfill } from "../app/journal/journalSeasonalityBackfillService.js";

function parseArgs(argv) {
  const opts = { dryRun: true, limit: null, symbols: null };
  for (const arg of argv) {
    if (arg === "--write") {
      opts.dryRun = false;
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      opts.limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
    } else if (arg.startsWith("--symbols=")) {
      opts.symbols = arg
        .slice("--symbols=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.dryRun ? "dry-run" : "write";

  console.log(
    `[backfill-journal-seasonality] mode=${mode} cache-only=true yahoo=none` +
      (opts.limit != null ? ` limit=${opts.limit}` : "") +
      (opts.symbols ? ` symbols=${opts.symbols.join(",")}` : "")
  );

  const summary = runJournalSeasonalityBackfill(opts);

  console.log(JSON.stringify(summary, null, 2));

  if (summary.dryRun) {
    console.log(
      `[backfill-journal-seasonality] DRY-RUN — aucune écriture. ` +
        `${summary.tickersUpdated} ticker(s) prêts, ${summary.recordsWouldUpdate} record(s) seraient mis à jour. ` +
        `Relancer avec --write pour appliquer.`
    );
  } else {
    console.log(
      `[backfill-journal-seasonality] WRITE — ${summary.recordsUpdated} record(s) mis à jour ` +
        `sur ${summary.tickersUpdated} ticker(s).`
    );
  }

  if (summary.errors.length) {
    process.exitCode = 1;
  }
}

main();
