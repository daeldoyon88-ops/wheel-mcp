/**
 * Capital agrégé affiché pour une ligne de combo (pick).
 * AF-10 : priorise capitalUsed ; fallback per-contrat × contracts pour objets legacy.
 */
export function resolvePickLineCapital(pick) {
  const used = Number(pick?.capitalUsed);
  if (Number.isFinite(used) && used >= 0) {
    return used;
  }

  const perContractRaw = pick?.capitalPerContract ?? pick?.capitalRequired;
  const perContract = Number(perContractRaw);
  const contractsRaw = Number(pick?.contracts ?? 1);
  const contracts =
    Number.isFinite(contractsRaw) && contractsRaw > 0 ? contractsRaw : 1;

  if (Number.isFinite(perContract) && perContract >= 0) {
    return perContract * contracts;
  }

  return 0;
}

/**
 * Ticker dominant et % de concentration sur capital agrégé (aligné moteur largestTickerCapitalPct).
 */
export function resolveDominantTickerCapital(picks) {
  const list = picks ?? [];
  if (list.length === 0) return null;

  const total = list.reduce((s, p) => s + resolvePickLineCapital(p), 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const byTicker = {};
  for (const p of list) {
    const ticker = p?.ticker;
    if (!ticker) continue;
    byTicker[ticker] = (byTicker[ticker] ?? 0) + resolvePickLineCapital(p);
  }

  let topTicker = null;
  let topValue = 0;
  for (const [ticker, value] of Object.entries(byTicker)) {
    if (value > topValue) {
      topValue = value;
      topTicker = ticker;
    }
  }
  if (!topTicker) return null;

  const pct = (topValue / total) * 100;
  return {
    ticker: topTicker,
    pct: Number.isFinite(pct) ? pct : 0,
    capital: topValue,
  };
}

/** @deprecated Alias interne — préférer resolvePickLineCapital */
export function resolveDominantFromCapitalRequired(picks) {
  const list = picks ?? [];
  const total = list.reduce((s, p) => s + Number(p?.capitalRequired ?? 0), 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const byTicker = {};
  for (const p of list) {
    const ticker = p?.ticker;
    if (!ticker) continue;
    byTicker[ticker] = (byTicker[ticker] ?? 0) + Number(p?.capitalRequired ?? 0);
  }
  let topTicker = null;
  let topValue = 0;
  for (const [ticker, value] of Object.entries(byTicker)) {
    if (value > topValue) {
      topValue = value;
      topTicker = ticker;
    }
  }
  if (!topTicker) return null;
  return { ticker: topTicker, pct: (topValue / total) * 100, capital: topValue };
}
