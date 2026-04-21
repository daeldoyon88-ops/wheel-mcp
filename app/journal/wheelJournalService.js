export function createWheelJournalService() {
  const entries = [];

  function listEntries() {
    return [...entries];
  }

  function addEntry(entry) {
    const normalized = {
      id: entry?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ticker: String(entry?.ticker ?? "").toUpperCase(),
      type: entry?.type ?? "note",
      premiumCollected: Number(entry?.premiumCollected ?? 0),
      collateral: Number(entry?.collateral ?? 0),
      assigned: Boolean(entry?.assigned ?? false),
      coveredCall: Boolean(entry?.coveredCall ?? false),
      createdAt: entry?.createdAt ?? new Date().toISOString(),
    };
    entries.push(normalized);
    return normalized;
  }

  function summarizeByTicker() {
    const grouped = new Map();
    for (const row of entries) {
      const ticker = row.ticker || "UNKNOWN";
      if (!grouped.has(ticker)) {
        grouped.set(ticker, {
          ticker,
          trades: 0,
          premiumCollected: 0,
          collateral: 0,
          assignments: 0,
          coveredCalls: 0,
        });
      }
      const current = grouped.get(ticker);
      current.trades += 1;
      current.premiumCollected += row.premiumCollected;
      current.collateral += row.collateral;
      if (row.assigned) current.assignments += 1;
      if (row.coveredCall) current.coveredCalls += 1;
    }
    return [...grouped.values()];
  }

  return {
    listEntries,
    addEntry,
    summarizeByTicker,
  };
}
