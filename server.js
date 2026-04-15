async function fetchOptionsForExpiration(symbol, expirationInput) {
  const expirationDate = normalizeExpirationInput(expirationInput);

  const data = await yahooFinance.options(symbol, { date: expirationDate });
  console.error("RAW OPTIONS RESPONSE:", JSON.stringify(data, null, 2));

  const quote = data?.quote ?? {};
  const spot = getSpotFromQuote(quote);

  let callsRaw = [];
  let putsRaw = [];
  let resolvedExpiration = expirationDate;

  // Cas 1 : structure data.options[0].calls / puts
  if (Array.isArray(data?.options) && data.options.length > 0) {
    const bucket = data.options[0];
    callsRaw = Array.isArray(bucket?.calls) ? bucket.calls : [];
    putsRaw = Array.isArray(bucket?.puts) ? bucket.puts : [];

    if (bucket?.expirationDate) {
      resolvedExpiration = new Date(bucket.expirationDate);
    }
  }

  // Cas 2 : structure directe data.calls / data.puts
  if (callsRaw.length === 0 && Array.isArray(data?.calls)) {
    callsRaw = data.calls;
  }

  if (putsRaw.length === 0 && Array.isArray(data?.puts)) {
    putsRaw = data.puts;
  }

  // Cas 3 : fallback défensif si Yahoo renvoie une autre forme
  if (callsRaw.length === 0 && putsRaw.length === 0 && data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const value = data[key];

      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];

        if (first && typeof first === "object" && "strike" in first) {
          const maybeCalls = value.filter(
            (x) =>
              typeof x?.contractSymbol === "string" &&
              x.contractSymbol.includes("C")
          );

          const maybePuts = value.filter(
            (x) =>
              typeof x?.contractSymbol === "string" &&
              x.contractSymbol.includes("P")
          );

          if (maybeCalls.length > 0 || maybePuts.length > 0) {
            callsRaw = maybeCalls;
            putsRaw = maybePuts;
            break;
          }
        }
      }
    }
  }

  const calls = callsRaw.map((c) =>
    normalizeOptionContract(c, "call", resolvedExpiration, spot)
  );

  const puts = putsRaw.map((p) =>
    normalizeOptionContract(p, "put", resolvedExpiration, spot)
  );

  return {
    symbol,
    quote,
    spot,
    underlyingSymbol: data?.underlyingSymbol ?? symbol,
    expiration: resolvedExpiration.toISOString(),
    expirationDate: toISODateOnly(resolvedExpiration),
    dte: daysToExpiration(resolvedExpiration),
    hasMiniOptions: Boolean(data?.hasMiniOptions),
    strikes: Array.isArray(data?.strikes) ? data.strikes : [],
    calls,
    puts,
    rawCount: {
      calls: calls.length,
      puts: puts.length,
    },
  };
}