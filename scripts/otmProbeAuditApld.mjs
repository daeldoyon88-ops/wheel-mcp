/**
 * Audit read-only : sonde OTM Yahoo pour un ticker (défaut APLD).
 * Compare 0 % vs N % sans modifier la stratégie Wheel.
 *
 * Usage:
 *   node scripts/otmProbeAuditApld.mjs
 *   node scripts/otmProbeAuditApld.mjs APLD --levels 0,6
 *   node scripts/otmProbeAuditApld.mjs APLD --levels 0,3,4,5,6 --json-out audit.json
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LIQUIDITY_OTM_PROBE_PCT } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { createMarketService } from "../app/services/marketService.js";
import { evaluateAtmPutLiquidity, evaluateOtmPutLiquidityProbe } from "../app/watchlist/watchlistFilters.js";
import { evaluateLiquidity } from "../app/calculations/wheelMetrics.js";
import { toNumber } from "../app/utils/number.js";

function parseArgs(argv) {
  const positional = [];
  let levels = [0, 6];
  let jsonOut = null;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--levels" && argv[i + 1]) {
      levels = String(argv[i + 1])
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
      i += 1;
      continue;
    }
    if (a === "--json-out" && argv[i + 1]) {
      jsonOut = argv[i + 1];
      i += 1;
      continue;
    }
    if (!a.startsWith("-")) positional.push(a);
  }
  return { symbol: (positional[0] || "APLD").toUpperCase(), levels, jsonOut };
}

/** Même résolution que watchlistBuilder.js (l.642-646). */
export function resolveEffectiveOtmProbePercent(criteriaValue) {
  const probeRaw = criteriaValue;
  const probePct =
    typeof probeRaw === "number" && Number.isFinite(probeRaw)
      ? probeRaw
      : DEFAULT_LIQUIDITY_OTM_PROBE_PCT;
  return {
    selectedOtmProbePercentFromUi: probeRaw ?? null,
    backendOtmProbePercent: probePct,
    effectiveOtmProbePercent: probePct,
    probeMode: probePct > 0 ? "OTM_PROBE" : "ATM_ONLY",
    fallbackReason:
      typeof probeRaw !== "number" || !Number.isFinite(probeRaw)
        ? `missing_or_invalid → default ${DEFAULT_LIQUIDITY_OTM_PROBE_PCT}`
        : probePct === 0
          ? "explicit_zero_disables_otm"
          : null,
  };
}

function isUsMarketClosedNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  if (weekday === "Sat" || weekday === "Sun") return true;
  return mins < 9 * 60 + 30 || mins >= 16 * 60;
}

function pickNearestExpiration(dates) {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = (dates || []).filter((d) => typeof d === "string" && d >= today).sort();
  return sorted[0] ?? null;
}

function buildOtmAuditRow({ symbol, probePctRequested, spot, chain, nearestExpiration, atm, otm }) {
  const resolved = resolveEffectiveOtmProbePercent(probePctRequested);
  const thresholdStrike =
    resolved.effectiveOtmProbePercent > 0 ? spot * (1 - resolved.effectiveOtmProbePercent / 100) : null;

  const puts = Array.isArray(chain?.puts) ? chain.puts : [];
  const candidates = puts
    .map((row) => ({ row, strike: toNumber(row?.strike) }))
    .filter((x) => x.strike > 0 && (thresholdStrike == null || x.strike <= thresholdStrike))
    .sort((a, b) => b.strike - a.strike)
    .slice(0, 8)
    .map(({ row, strike }) => {
      const liq = evaluateLiquidity(row);
      return {
        strike,
        bid: row?.bid,
        ask: row?.ask,
        otmPct: spot > 0 ? +(((spot - strike) / spot) * 100).toFixed(2) : null,
        isLiquid: liq?.isLiquid === true,
        spreadPct: liq?.spreadPct ?? null,
        rejectReason: liq?.checks?.rejectReason ?? null,
      };
    });

  const probePass = resolved.effectiveOtmProbePercent <= 0 ? true : otm?.ok === true;
  const probeRejectReason =
    resolved.effectiveOtmProbePercent <= 0
      ? null
      : otm?.ok
        ? null
        : otm?.reason ?? "unknown";

  return {
    ticker: symbol,
    ...resolved,
    marketSession: isUsMarketClosedNow() ? "closed" : "open",
    isMarketClosed: isUsMarketClosedNow(),
    usesFrozenData: false,
    dataSource: "yahoo_via_marketService",
    targetExpiration: nearestExpiration,
    spot,
    atmCandidate: atm?.detail ?? null,
    atmPass: atm?.ok === true,
    otmProbeStrikeTarget: thresholdStrike != null ? +thresholdStrike.toFixed(4) : null,
    testedStrikes: candidates,
    otmCandidate: otm?.detail ?? null,
    probePass,
    probeRejectReason,
    watchlistHardRejectInStrict: probePass === false,
    watchlistSoftPenaltyInRelaxed: probePass === false ? "liquid_options_otm_probe_failed (-8)" : null,
  };
}

async function main() {
  const { symbol, levels, jsonOut } = parseArgs(process.argv);
  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);

  const quote = await marketService.getQuote(symbol);
  const spot = toNumber(quote?.regularMarketPrice);
  const exp = await marketService.getOptionExpirations(symbol);
  const dates = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
  const nearest = pickNearestExpiration(dates);
  if (!nearest) {
    console.error(`[OTM_PROBE_AUDIT] ${symbol}: aucune expiration disponible`);
    process.exit(1);
  }
  const chain = await marketService.getOptionChain(symbol, nearest);
  const spotForChain = toNumber(chain?.currentPrice) || spot;
  const atm = evaluateAtmPutLiquidity(chain, spotForChain);

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const pct of levels) {
    const otm = pct > 0 ? evaluateOtmPutLiquidityProbe(chain, spotForChain, pct) : { ok: true, detail: { skipped: true } };
    const row = buildOtmAuditRow({
      symbol,
      probePctRequested: pct,
      spot: spotForChain,
      chain,
      nearestExpiration: nearest,
      atm,
      otm,
    });
    rows.push(row);
    console.log("[OTM_PROBE_AUDIT]", JSON.stringify(row, null, 0));
  }

  console.log("\n--- Résumé ---");
  console.log("ticker | OTM demandé | OTM utilisé | probeMode | pass/fail | raison");
  for (const r of rows) {
    console.log(
      `${r.ticker} | ${r.selectedOtmProbePercentFromUi}% | ${r.effectiveOtmProbePercent}% | ${r.probeMode} | ${r.probePass ? "PASS" : "FAIL"} | ${r.probeRejectReason ?? "—"}`
    );
  }

  const payload = { symbol, capturedAt: new Date().toISOString(), rows };
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nJSON écrit : ${resolve(jsonOut)}`);
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[OTM_PROBE_AUDIT] error:", err?.message || err);
    process.exit(1);
  });
}
