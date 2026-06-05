#!/usr/bin/env node
/**
 * CLI — Backfill saisonnalité Journal POP (dry-run par défaut).
 *
 * Mode cache-only (défaut) :
 *   Remplit les 7 colonnes seasonality_* depuis seasonality_cache uniquement.
 *   AUCUN appel Yahoo.
 *
 * Mode fetch-missing (--fetch-missing) :
 *   Pour tickers sans cache, calcule + persiste le bundle Yahoo.
 *   Yahoo réel UNIQUEMENT avec --write --fetch-missing (pas en dry-run).
 *
 * Usage :
 *   node scripts/backfillJournalSeasonality.mjs               # dry-run cache-only
 *   node scripts/backfillJournalSeasonality.mjs --write         # applique les UPDATE (cache-only)
 *   node scripts/backfillJournalSeasonality.mjs --fetch-missing --limit=2
 *   node scripts/backfillJournalSeasonality.mjs --write --fetch-missing --limit=5
 *   node scripts/backfillJournalSeasonality.mjs --symbols=TQQQ,SOFI
 *   node scripts/backfillJournalSeasonality.mjs --delay-ms=3000
 */

import {
  runJournalSeasonalityBackfill,
  MAX_FETCH_LIMIT,
  DEFAULT_FETCH_DELAY_MS,
} from "../app/journal/journalSeasonalityBackfillService.js";

const DEFAULT_FETCH_MISSING_LIMIT = 5;

function parseArgs(argv) {
  const opts = {
    dryRun: true,
    fetchMissing: false,
    limit: null,
    limitExplicit: false,
    symbols: null,
    delayMs: DEFAULT_FETCH_DELAY_MS,
  };
  for (const arg of argv) {
    if (arg === "--write") {
      opts.dryRun = false;
    } else if (arg === "--fetch-missing") {
      opts.fetchMissing = true;
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      opts.limit = Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
      opts.limitExplicit = true;
    } else if (arg.startsWith("--symbols=")) {
      opts.symbols = arg
        .slice("--symbols=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg.startsWith("--delay-ms=")) {
      const n = Number(arg.slice("--delay-ms=".length));
      if (Number.isFinite(n) && n >= 0) opts.delayMs = Math.trunc(n);
    }
  }

  if (opts.fetchMissing && !opts.limitExplicit) {
    opts.limit = DEFAULT_FETCH_MISSING_LIMIT;
  }

  return opts;
}

function validateFetchLimits(opts) {
  if (!opts.fetchMissing) return null;
  if (opts.limit != null && opts.limit > MAX_FETCH_LIMIT) {
    return (
      `[backfill-journal-seasonality] ERREUR — limit=${opts.limit} dépasse le plafond ` +
      `Yahoo de ${MAX_FETCH_LIMIT} tickers par run. ` +
      `Réduire --limit ou retirer --fetch-missing pour un backfill cache-only sans plafond.`
    );
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const limitError = validateFetchLimits(opts);
  if (limitError) {
    console.error(limitError);
    process.exitCode = 1;
    return;
  }

  const mode = opts.dryRun ? "dry-run" : "write";
  const yahooMode = opts.fetchMissing
    ? opts.dryRun
      ? "planned-only"
      : "enabled"
    : "none";

  console.log(
    `[backfill-journal-seasonality] mode=${mode}` +
      ` cache-only=${!opts.fetchMissing}` +
      ` fetch-missing=${opts.fetchMissing}` +
      ` yahoo=${yahooMode}` +
      (opts.limit != null ? ` limit=${opts.limit}` : "") +
      (opts.fetchMissing ? ` delay-ms=${opts.delayMs}` : "") +
      (opts.symbols ? ` symbols=${opts.symbols.join(",")}` : "")
  );

  const summary = await runJournalSeasonalityBackfill({
    dryRun: opts.dryRun,
    fetchMissing: opts.fetchMissing,
    limit: opts.limit,
    symbols: opts.symbols,
    delayMs: opts.delayMs,
  });

  console.log(JSON.stringify(summary, null, 2));

  if (summary.dryRun) {
    const fetchNote = summary.fetchMissing
      ? ` ${summary.tickersWouldFetch} ticker(s) seraient fetchés via Yahoo (aucun appel en dry-run).`
      : "";
    console.log(
      `[backfill-journal-seasonality] DRY-RUN — aucune écriture.${fetchNote} ` +
        `${summary.tickersUpdated} ticker(s) prêts, ${summary.recordsWouldUpdate} record(s) seraient mis à jour. ` +
        `Relancer avec --write${summary.fetchMissing ? " --fetch-missing" : ""} pour appliquer.`
    );
  } else {
    const fetchNote = summary.fetchMissing
      ? ` (${summary.tickersWouldFetch} fetch Yahoo planifié(s) en dry-run)`
      : "";
    console.log(
      `[backfill-journal-seasonality] WRITE — ${summary.recordsUpdated} record(s) mis à jour ` +
        `sur ${summary.tickersUpdated} ticker(s).${fetchNote}`
    );
  }

  if (summary.errors.length) {
    process.exitCode = 1;
  }
}

main();
