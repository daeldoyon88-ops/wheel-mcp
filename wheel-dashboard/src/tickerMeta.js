// Ticker display metadata — company name, type/sector, quality tier.
// Local static table only: fills what the scanner does not return.
// Update this file to add/correct entries; never edit IBKR or scanner logic here.

/** @type {Record<string, { name: string, type: string, sector: string, qualityTier: string }>} */
export const TICKER_META = {
  // ─── Favoris utilisateur ───────────────────────────────────────────────────
  TQQQ: { name: "ProShares UltraPro QQQ", type: "Leveraged ETF 3×", sector: "ETF Tech", qualityTier: "Thématique risqué" },
  SOFI: { name: "SoFi Technologies", type: "Fintech", sector: "Financial Services", qualityTier: "Spéculatif favori" },
  APLD: { name: "Applied Digital Corp.", type: "IA / Infrastructure Cloud", sector: "Technology", qualityTier: "Spéculatif favori" },
  HOOD: { name: "Robinhood Markets", type: "Fintech / Courtage", sector: "Financial Services", qualityTier: "Spéculatif favori" },
  AFRM: { name: "Affirm Holdings", type: "Fintech / BNPL", sector: "Consumer Finance", qualityTier: "Spéculatif favori" },
  BITX: { name: "2× Bitcoin Strategy ETF", type: "Crypto ETF Levier", sector: "Crypto", qualityTier: "Thématique risqué" },

  // ─── Crypto bloqués ────────────────────────────────────────────────────────
  IBIT: { name: "iShares Bitcoin Trust", type: "Crypto ETF Spot", sector: "Crypto", qualityTier: "Crypto bloqué" },
  BITO: { name: "ProShares Bitcoin Strategy ETF", type: "Crypto ETF", sector: "Crypto", qualityTier: "Crypto bloqué" },
  RIOT: { name: "Riot Platforms", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  CIFR: { name: "Cipher Mining", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  WULF: { name: "TeraWulf", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  IREN: { name: "Iris Energy", type: "Crypto Miner / HPC", sector: "Crypto", qualityTier: "Crypto bloqué" },
  MARA: { name: "Marathon Digital Holdings", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  CLSK: { name: "CleanSpark", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  HUT: { name: "Hut 8 Corp.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  BTBT: { name: "Bit Digital", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  COIN: { name: "Coinbase Global", type: "Crypto Exchange", sector: "Financial Services", qualityTier: "Crypto bloqué" },
  BITF: { name: "Bitfarms Ltd.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },

  // ─── Exemples de validation ────────────────────────────────────────────────
  NOK: { name: "Nokia Oyj", type: "Équipement Télécom", sector: "Communication Equipment", qualityTier: "Core Quality" },
  HAL: { name: "Halliburton Co.", type: "Services Pétroliers", sector: "Energy", qualityTier: "Cyclique" },
  KWEB: { name: "KraneShares China Internet ETF", type: "China Tech ETF", sector: "ETF Thématique", qualityTier: "Thématique risqué" },
  B: { name: "Barnes Group Inc.", type: "Industriel / Aéronautique", sector: "Industrials", qualityTier: "Core Quality" },
  BMNR: { name: "BitMiner Inc.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },

  // ─── Large caps — Core Quality ─────────────────────────────────────────────
  AAPL: { name: "Apple Inc.", type: "Consumer Tech", sector: "Technology", qualityTier: "Core Quality" },
  AMZN: { name: "Amazon.com Inc.", type: "Cloud / E-Commerce", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  NVDA: { name: "NVIDIA Corp.", type: "Semi-conducteurs / IA", sector: "Technology", qualityTier: "Core Quality" },
  MSFT: { name: "Microsoft Corp.", type: "Cloud / Enterprise Tech", sector: "Technology", qualityTier: "Core Quality" },
  GOOGL: { name: "Alphabet Inc.", type: "Tech / Publicité", sector: "Technology", qualityTier: "Core Quality" },
  AVGO: { name: "Broadcom Inc.", type: "Semi-conducteurs", sector: "Technology", qualityTier: "Core Quality" },
  TSM: { name: "Taiwan Semiconductor Mfg.", type: "Fonderie Semi-conducteurs", sector: "Technology", qualityTier: "Core Quality" },
  MRVL: { name: "Marvell Technology", type: "Semi-conducteurs / Réseau", sector: "Technology", qualityTier: "Core Quality" },
  ORCL: { name: "Oracle Corp.", type: "Cloud / ERP / BDD", sector: "Technology", qualityTier: "Core Quality" },
  DELL: { name: "Dell Technologies", type: "Serveurs / PC / IT", sector: "Technology", qualityTier: "Core Quality" },

  // ─── Tech — Cyclique ───────────────────────────────────────────────────────
  AMD: { name: "Advanced Micro Devices", type: "Semi-conducteurs / CPU-GPU", sector: "Technology", qualityTier: "Cyclique" },
  MU: { name: "Micron Technology", type: "Semi-conducteurs / Mémoire", sector: "Technology", qualityTier: "Cyclique" },
  INTC: { name: "Intel Corp.", type: "Semi-conducteurs / CPU", sector: "Technology", qualityTier: "Cyclique" },
  SNOW: { name: "Snowflake Inc.", type: "Cloud / Data Platform", sector: "Technology", qualityTier: "Cyclique" },
  SHOP: { name: "Shopify Inc.", type: "Commerce / SaaS", sector: "Technology", qualityTier: "Cyclique" },
  DOCU: { name: "DocuSign Inc.", type: "Cloud / Signature", sector: "Technology", qualityTier: "Cyclique" },
  ZM: { name: "Zoom Video Commun.", type: "Cloud / Vidéo", sector: "Technology", qualityTier: "Cyclique" },
  DUOL: { name: "Duolingo Inc.", type: "EdTech / IA", sector: "Technology", qualityTier: "Cyclique" },
  DXCM: { name: "Dexcom Inc.", type: "Medtech / Glucose CGM", sector: "Healthcare", qualityTier: "Cyclique" },

  // ─── Tech / IA — Spéculatif favori ────────────────────────────────────────
  PLTR: { name: "Palantir Technologies", type: "IA / Données Gov & Défense", sector: "Technology", qualityTier: "Spéculatif favori" },
  PATH: { name: "UiPath Inc.", type: "IA / RPA / Automatisation", sector: "Technology", qualityTier: "Spéculatif favori" },
  OKLO: { name: "Oklo Inc.", type: "Énergie Nucléaire SMR", sector: "Energy", qualityTier: "Spéculatif favori" },
  IONQ: { name: "IonQ Inc.", type: "Informatique Quantique", sector: "Technology", qualityTier: "Spéculatif favori" },
  SOUN: { name: "SoundHound AI", type: "IA Vocale", sector: "Technology", qualityTier: "Spéculatif favori" },
  RGTI: { name: "Rigetti Computing", type: "Informatique Quantique", sector: "Technology", qualityTier: "Spéculatif favori" },
  RKLB: { name: "Rocket Lab USA", type: "Spatial / Lanceurs", sector: "Industrials", qualityTier: "Spéculatif favori" },
  UPST: { name: "Upstart Holdings", type: "Fintech / Crédit IA", sector: "Financial Services", qualityTier: "Spéculatif favori" },
  SMCI: { name: "Super Micro Computer", type: "Serveurs IA / GPU Rack", sector: "Technology", qualityTier: "Spéculatif favori" },
  U: { name: "Unity Software", type: "Gaming Engine / 3D", sector: "Technology", qualityTier: "Spéculatif favori" },
  ROKU: { name: "Roku Inc.", type: "Streaming / AdTech", sector: "Communication Services", qualityTier: "Spéculatif favori" },
  DKNG: { name: "DraftKings Inc.", type: "Paris Sportifs / Tech", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },
  ROOT: { name: "Root Insurance", type: "Insurtech / IA", sector: "Financial Services", qualityTier: "Spéculatif favori" },
  HIMS: { name: "Hims & Hers Health", type: "Santé / DTC / Télémédecine", sector: "Healthcare", qualityTier: "Spéculatif favori" },

  // ─── Finance — Core Quality ────────────────────────────────────────────────
  BAC: { name: "Bank of America", type: "Banque Universelle", sector: "Financial Services", qualityTier: "Core Quality" },
  SCHW: { name: "Charles Schwab Corp.", type: "Courtage / Gestion", sector: "Financial Services", qualityTier: "Core Quality" },
  IBKR: { name: "Interactive Brokers", type: "Courtage Institutionnel", sector: "Financial Services", qualityTier: "Core Quality" },
  USB: { name: "U.S. Bancorp", type: "Banque Régionale", sector: "Financial Services", qualityTier: "Core Quality" },
  NDAQ: { name: "Nasdaq Inc.", type: "Bourse / Fintech / Données", sector: "Financial Services", qualityTier: "Core Quality" },
  TW: { name: "Tradeweb Markets", type: "Marchés Obligataires / Tech", sector: "Financial Services", qualityTier: "Core Quality" },
  CVS: { name: "CVS Health Corp.", type: "Pharmacie / Santé Intégrée", sector: "Healthcare", qualityTier: "Core Quality" },

  // ─── Finance — Cyclique ────────────────────────────────────────────────────
  PYPL: { name: "PayPal Holdings", type: "Fintech / Paiements", sector: "Financial Services", qualityTier: "Cyclique" },

  // ─── Consumer Discretionary ───────────────────────────────────────────────
  UBER: { name: "Uber Technologies", type: "Mobilité / Livraison / Tech", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  SBUX: { name: "Starbucks Corp.", type: "Restauration / Franchise", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  TGT: { name: "Target Corp.", type: "Grande Distribution", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  EXPE: { name: "Expedia Group", type: "Voyage / OTA / Tech", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  TSCO: { name: "Tractor Supply Co.", type: "Retail Agricole / Lifestyle", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  DECK: { name: "Deckers Outdoor Corp.", type: "Chaussures / Lifestyle", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  LVS: { name: "Las Vegas Sands Corp.", type: "Casinos Asie / Resort", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  F: { name: "Ford Motor Co.", type: "Automobile / EV", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  GM: { name: "General Motors Co.", type: "Automobile / EV", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  RYAAY: { name: "Ryanair Holdings", type: "Aviation Low-Cost", sector: "Industrials", qualityTier: "Cyclique" },
  PDD: { name: "PDD Holdings (Temu/Pinduoduo)", type: "E-Commerce Chine", sector: "Consumer Discretionary", qualityTier: "Thématique risqué" },
  PHM: { name: "PulteGroup Inc.", type: "Construction Résidentielle", sector: "Industrials", qualityTier: "Cyclique" },

  // ─── Consumer Staples ─────────────────────────────────────────────────────
  KO: { name: "The Coca-Cola Co.", type: "Boissons / Défensif", sector: "Consumer Staples", qualityTier: "Core Quality" },

  // ─── Communication Services ───────────────────────────────────────────────
  NFLX: { name: "Netflix Inc.", type: "Streaming / Contenu", sector: "Communication Services", qualityTier: "Core Quality" },
  WBD: { name: "Warner Bros. Discovery", type: "Streaming / Médias", sector: "Communication Services", qualityTier: "Cyclique" },

  // ─── Énergie ──────────────────────────────────────────────────────────────
  SLB: { name: "SLB (Schlumberger)", type: "Services Pétroliers", sector: "Energy", qualityTier: "Cyclique" },
  FSLR: { name: "First Solar Inc.", type: "Panneaux Solaires / Utility", sector: "Energy", qualityTier: "Cyclique" },
  KMI: { name: "Kinder Morgan", type: "Pipelines / Midstream", sector: "Energy", qualityTier: "Core Quality" },
  VST: { name: "Vistra Corp.", type: "Électricité / Énergie", sector: "Utilities", qualityTier: "Core Quality" },
  TECK: { name: "Teck Resources", type: "Mines / Cuivre / Zinc", sector: "Materials", qualityTier: "Cyclique" },
  NEM: { name: "Newmont Corp.", type: "Mines / Or", sector: "Materials", qualityTier: "Cyclique" },

  // ─── Utilities ────────────────────────────────────────────────────────────
  PCG: { name: "PG&E Corp.", type: "Électricité / Gaz Californie", sector: "Utilities", qualityTier: "Core Quality" },
  NI: { name: "NiSource Inc.", type: "Gaz Naturel / Électricité", sector: "Utilities", qualityTier: "Core Quality" },

  // ─── Santé ────────────────────────────────────────────────────────────────
  ABT: { name: "Abbott Laboratories", type: "Dispositifs Médicaux", sector: "Healthcare", qualityTier: "Core Quality" },
  NVO: { name: "Novo Nordisk A/S", type: "Pharma / GLP-1 / Diabète", sector: "Healthcare", qualityTier: "Core Quality" },
  INCY: { name: "Incyte Corp.", type: "Biotech / Oncologie", sector: "Healthcare", qualityTier: "Cyclique" },
  NBIX: { name: "Neurocrine Biosciences", type: "Biotech / Neurologie", sector: "Healthcare", qualityTier: "Cyclique" },

  // ─── Industrials ──────────────────────────────────────────────────────────
  CSX: { name: "CSX Corp.", type: "Transport Ferroviaire", sector: "Industrials", qualityTier: "Core Quality" },

  // ─── Matériaux ────────────────────────────────────────────────────────────
  CF: { name: "CF Industries Holdings", type: "Engrais / Chimie Azotée", sector: "Materials", qualityTier: "Cyclique" },

  // ─── ETF Thématique / Matières premières ──────────────────────────────────
  SLV: { name: "iShares Silver Trust", type: "ETF Argent", sector: "Commodities", qualityTier: "Thématique risqué" },

  // ─── ETF Leveraged ────────────────────────────────────────────────────────
  SOXL: { name: "Direxion Semiconductor 3× ETF", type: "Leveraged ETF 3×", sector: "ETF Semi-conducteurs", qualityTier: "Thématique risqué" },
};

// ─── Préférences utilisateur ──────────────────────────────────────────────────
export const USER_PREFS = {
  /** Tickers suivis en priorité — badge favori affiché sur la carte. */
  favorites: new Set(["TQQQ", "SOFI", "APLD", "HOOD", "AFRM", "BITX"]),
  /** Seul crypto autorisé explicitement dans la stratégie Wheel. */
  cryptoAllowed: new Set(["BITX"]),
  /** Crypto à masquer / déclasser — ne conviennent pas à la stratégie Wheel. */
  cryptoBlocked: new Set([
    "IBIT", "BITO", "RIOT", "CIFR", "WULF", "IREN",
    "MARA", "CLSK", "HUT", "BTBT", "COIN", "BITF", "BMNR",
  ]),
};

// ─── Styles dark-premium par tier ─────────────────────────────────────────────
export const QUALITY_TIER_STYLE = {
  "Core Quality":       { badge: "border-emerald-700 bg-emerald-950 text-emerald-300" },
  "Cyclique":           { badge: "border-amber-700   bg-amber-950   text-amber-300"   },
  "Spéculatif favori":  { badge: "border-violet-700  bg-violet-950  text-violet-300"  },
  "Thématique risqué":  { badge: "border-orange-700  bg-orange-950  text-orange-300"  },
  "Crypto bloqué":      { badge: "border-rose-700    bg-rose-950    text-rose-300"    },
  "Inconnu à valider":  { badge: "border-slate-600   bg-slate-800   text-slate-400"   },
};

/**
 * Retourne le méta-affichage d'un ticker.
 * Toujours retourne un objet valide — jamais null.
 *
 * @param {string} symbol
 * @returns {{ name: string|null, type: string|null, sector: string|null, qualityTier: string, isFavorite: boolean, isCryptoBlocked: boolean, isCryptoAllowed: boolean }}
 */
export function getTickerDisplayMeta(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  const meta = TICKER_META[sym] ?? null;
  return {
    name:            meta?.name    ?? null,
    type:            meta?.type    ?? null,
    sector:          meta?.sector  ?? null,
    qualityTier:     meta?.qualityTier ?? "Inconnu à valider",
    isFavorite:      USER_PREFS.favorites.has(sym),
    isCryptoBlocked: USER_PREFS.cryptoBlocked.has(sym),
    isCryptoAllowed: USER_PREFS.cryptoAllowed.has(sym),
  };
}
