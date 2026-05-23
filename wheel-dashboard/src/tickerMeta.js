// Ticker display metadata — company name, type/sector, quality tier.
// Local static table only: fills what the scanner does not return.
// Update this file to add/correct entries; never edit IBKR or scanner logic here.

/** @type {Record<string, { name: string, type: string, sector: string, qualityTier: string }>} */
export const TICKER_META = {
  // ─── Favoris utilisateur ───────────────────────────────────────────────────
  TQQQ: { name: "ProShares UltraPro QQQ", type: "Leveraged ETF 3×", sector: "ETF à levier / Nasdaq 100", qualityTier: "Spéculatif favori" },
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
  HUT:  { name: "Hut 8 Corp.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  BTBT: { name: "Bit Digital", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  COIN: { name: "Coinbase Global", type: "Crypto Exchange", sector: "Financial Services", qualityTier: "Crypto bloqué" },
  BITF: { name: "Bitfarms Ltd.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },
  CORZ: { name: "Core Scientific Inc.", type: "Crypto Miner / Infrastructure HPC", sector: "Crypto", qualityTier: "Crypto bloqué" },
  ETHA: { name: "iShares Ethereum Trust ETF", type: "Crypto ETF Spot / Ethereum", sector: "Crypto", qualityTier: "Crypto bloqué" },

  // ─── Exemples de validation ────────────────────────────────────────────────
  NOK:  { name: "Nokia Oyj", type: "Équipement Télécom", sector: "Communication Equipment", qualityTier: "Core Quality" },
  HAL:  { name: "Halliburton Co.", type: "Services Pétroliers", sector: "Energy", qualityTier: "Cyclique" },
  KWEB: { name: "KraneShares China Internet ETF", type: "China Tech ETF", sector: "ETF Thématique", qualityTier: "Thématique risqué" },
  B:    { name: "Barnes Group Inc.", type: "Industriel / Aéronautique", sector: "Industrials", qualityTier: "Core Quality" },
  BMNR: { name: "BitMiner Inc.", type: "Crypto Miner", sector: "Crypto", qualityTier: "Crypto bloqué" },

  // ─── Large caps — Core Quality ─────────────────────────────────────────────
  AAPL:  { name: "Apple Inc.", type: "Consumer Tech", sector: "Technology", qualityTier: "Core Quality" },
  AMZN:  { name: "Amazon.com Inc.", type: "Cloud / E-Commerce", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  NVDA:  { name: "NVIDIA Corp.", type: "Semi-conducteurs / IA", sector: "Technology", qualityTier: "Core Quality" },
  MSFT:  { name: "Microsoft Corp.", type: "Cloud / Enterprise Tech", sector: "Technology", qualityTier: "Core Quality" },
  GOOGL: { name: "Alphabet Inc.", type: "Tech / Publicité", sector: "Technology", qualityTier: "Core Quality" },
  AVGO:  { name: "Broadcom Inc.", type: "Semi-conducteurs", sector: "Technology", qualityTier: "Core Quality" },
  TSM:   { name: "Taiwan Semiconductor Mfg.", type: "Fonderie Semi-conducteurs", sector: "Technology", qualityTier: "Core Quality" },
  MRVL:  { name: "Marvell Technology", type: "Semi-conducteurs / Réseau", sector: "Technology", qualityTier: "Core Quality" },
  ORCL:  { name: "Oracle Corp.", type: "Cloud / ERP / BDD", sector: "Technology", qualityTier: "Core Quality" },
  DELL:  { name: "Dell Technologies", type: "Serveurs / PC / IT", sector: "Technology", qualityTier: "Core Quality" },
  NOW:   { name: "ServiceNow", type: "Cloud / ITSM SaaS", sector: "Technology", qualityTier: "Core Quality" },

  // ─── Tech — Cyclique ───────────────────────────────────────────────────────
  AMD:  { name: "Advanced Micro Devices", type: "Semi-conducteurs / CPU-GPU", sector: "Technology", qualityTier: "Cyclique" },
  MU:   { name: "Micron Technology", type: "Semi-conducteurs / Mémoire", sector: "Technology", qualityTier: "Cyclique" },
  INTC: { name: "Intel Corp.", type: "Semi-conducteurs / CPU", sector: "Technology", qualityTier: "Cyclique" },
  SNOW: { name: "Snowflake Inc.", type: "Cloud / Data Platform", sector: "Technology", qualityTier: "Cyclique" },
  SHOP: { name: "Shopify Inc.", type: "Commerce / SaaS", sector: "Technology", qualityTier: "Cyclique" },
  DOCU: { name: "DocuSign Inc.", type: "Cloud / Signature", sector: "Technology", qualityTier: "Cyclique" },
  ZM:   { name: "Zoom Video Commun.", type: "Cloud / Vidéo", sector: "Technology", qualityTier: "Cyclique" },
  DUOL: { name: "Duolingo Inc.", type: "EdTech / IA", sector: "Technology", qualityTier: "Cyclique" },
  DXCM: { name: "Dexcom Inc.", type: "Medtech / Glucose CGM", sector: "Healthcare", qualityTier: "Cyclique" },
  HPE:  { name: "Hewlett Packard Enterprise", type: "Enterprise IT / Infrastructure", sector: "Technology", qualityTier: "Cyclique" },
  MCHP: { name: "Microchip Technology", type: "Semi-conducteurs / Microcontrôleurs", sector: "Technology", qualityTier: "Cyclique" },
  IGV:  { name: "iShares Expanded Tech-Software Sector ETF", type: "Sector ETF", sector: "Technology", qualityTier: "Thématique risqué" },
  HPQ:  { name: "HP Inc.", type: "PC / Imprimantes / Hardware", sector: "Technology", qualityTier: "Cyclique" },
  TTD:  { name: "The Trade Desk", type: "AdTech / Programmatique", sector: "Technology", qualityTier: "Cyclique" },

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
  U:    { name: "Unity Software", type: "Gaming Engine / 3D", sector: "Technology", qualityTier: "Spéculatif favori" },
  ROKU: { name: "Roku Inc.", type: "Streaming / AdTech", sector: "Communication Services", qualityTier: "Spéculatif favori" },
  DKNG: { name: "DraftKings Inc.", type: "Paris Sportifs / Tech", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },
  ROOT: { name: "Root Insurance", type: "Insurtech / IA", sector: "Financial Services", qualityTier: "Spéculatif favori" },
  HIMS: { name: "Hims & Hers Health", type: "Santé / DTC / Télémédecine", sector: "Healthcare", qualityTier: "Spéculatif favori" },
  TEM:  { name: "Tempus AI", type: "IA / Healthcare Data", sector: "Healthcare", qualityTier: "Spéculatif favori" },
  FLY:  { name: "Firefly Aerospace", type: "Spatial / Lanceurs", sector: "Industrials", qualityTier: "Spéculatif favori" },
  ONON: { name: "On Holding", type: "Chaussures / Apparel Growth", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },
  LYFT: { name: "Lyft", type: "Mobilité / Covoiturage", sector: "Technology", qualityTier: "Spéculatif favori" },
  RBLX: { name: "Roblox", type: "Gaming / Métaverse / Social", sector: "Technology", qualityTier: "Spéculatif favori" },
  CRWV: { name: "CoreWeave Inc.", type: "IA / Infrastructure Cloud GPU", sector: "Technology", qualityTier: "Spéculatif favori" },
  FIG:  { name: "Figma Inc.", type: "SaaS / Design & Collaboration", sector: "Technology", qualityTier: "Spéculatif favori" },
  S:    { name: "SentinelOne Inc.", type: "Cybersécurité / IA", sector: "Technology", qualityTier: "Spéculatif favori" },
  IOT:  { name: "Samsara Inc.", type: "IoT / Fleet Telematics / SaaS", sector: "Technology", qualityTier: "Spéculatif favori" },

  // ─── Finance — Core Quality ────────────────────────────────────────────────
  BAC:  { name: "Bank of America", type: "Banque Universelle", sector: "Financial Services", qualityTier: "Core Quality" },
  SCHW: { name: "Charles Schwab Corp.", type: "Courtage / Gestion", sector: "Financial Services", qualityTier: "Core Quality" },
  IBKR: { name: "Interactive Brokers", type: "Courtage Institutionnel", sector: "Financial Services", qualityTier: "Core Quality" },
  USB:  { name: "U.S. Bancorp", type: "Banque Régionale", sector: "Financial Services", qualityTier: "Core Quality" },
  NDAQ: { name: "Nasdaq Inc.", type: "Bourse / Fintech / Données", sector: "Financial Services", qualityTier: "Core Quality" },
  TW:   { name: "Tradeweb Markets", type: "Marchés Obligataires / Tech", sector: "Financial Services", qualityTier: "Core Quality" },
  CVS:  { name: "CVS Health Corp.", type: "Pharmacie / Santé Intégrée", sector: "Healthcare", qualityTier: "Core Quality" },
  WFC:  { name: "Wells Fargo", type: "Banque Universelle", sector: "Financials", qualityTier: "Core Quality" },
  KKR:  { name: "KKR & Co.", type: "Private Equity / Alternatives", sector: "Financials", qualityTier: "Core Quality" },
  FISV: { name: "Fiserv", type: "Fintech / Paiements B2B", sector: "Financials", qualityTier: "Core Quality" },
  FIS:  { name: "Fidelity National Information Services", type: "Fintech / Traitement Paiements", sector: "Financials", qualityTier: "Core Quality" },

  // ─── Finance — Cyclique ────────────────────────────────────────────────────
  PYPL: { name: "PayPal Holdings", type: "Fintech / Paiements", sector: "Financial Services", qualityTier: "Cyclique" },
  XYZ:  { name: "Block Inc.", type: "Fintech / Paiements / Crypto", sector: "Financials", qualityTier: "Cyclique" },
  NU:   { name: "Nu Holdings", type: "Neobank Amérique Latine", sector: "Financials", qualityTier: "Cyclique" },
  RKT:  { name: "Rocket Companies Inc.", type: "Fintech / Prêts Hypothécaires", sector: "Financial Services", qualityTier: "Cyclique" },

  // ─── Consumer Discretionary ───────────────────────────────────────────────
  UBER:  { name: "Uber Technologies", type: "Mobilité / Livraison / Tech", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  SBUX:  { name: "Starbucks Corp.", type: "Restauration / Franchise", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  TGT:   { name: "Target Corp.", type: "Grande Distribution", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  EXPE:  { name: "Expedia Group", type: "Voyage / OTA / Tech", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  TSCO:  { name: "Tractor Supply Co.", type: "Retail Agricole / Lifestyle", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  DECK:  { name: "Deckers Outdoor Corp.", type: "Chaussures / Lifestyle", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  LVS:   { name: "Las Vegas Sands Corp.", type: "Casinos Asie / Resort", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  F:     { name: "Ford Motor Co.", type: "Automobile / EV", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  GM:    { name: "General Motors Co.", type: "Automobile / EV", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  RYAAY: { name: "Ryanair Holdings", type: "Aviation Low-Cost", sector: "Industrials", qualityTier: "Cyclique" },
  PDD:   { name: "PDD Holdings (Temu/Pinduoduo)", type: "E-Commerce Chine", sector: "Consumer Discretionary", qualityTier: "Thématique risqué" },
  PHM:   { name: "PulteGroup Inc.", type: "Construction Résidentielle", sector: "Industrials", qualityTier: "Cyclique" },
  CCL:   { name: "Carnival Corporation", type: "Cruise Line / Tourisme", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  ETSY:  { name: "Etsy Inc.", type: "E-commerce Marketplace", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  MGM:   { name: "MGM Resorts International", type: "Casinos / Hôtels", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  NKE:   { name: "Nike", type: "Chaussures / Vêtements Global", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  CMG:   { name: "Chipotle Mexican Grill", type: "Restauration Fast-Casual", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  CVNA:  { name: "Carvana", type: "Auto / Commerce en Ligne", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },
  RIVN:  { name: "Rivian Automotive", type: "Véhicules Électriques", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },
  CZR:   { name: "Caesars Entertainment", type: "Casinos / Hôtels US", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  NCLH:  { name: "Norwegian Cruise Line", type: "Cruise Line / Tourisme", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  BBY:   { name: "Best Buy", type: "Retail Électronique Grand Public", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  CPNG:  { name: "Coupang", type: "E-Commerce Corée du Sud", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  W:     { name: "Wayfair", type: "E-Commerce Maison & Mobilier", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  SONY:  { name: "Sony Group Corp.", type: "Électronique / Jeux Vidéo / Médias", sector: "Consumer Discretionary", qualityTier: "Core Quality" },
  LI:    { name: "Li Auto Inc.", type: "Véhicules Électriques / Chine ADR", sector: "Consumer Discretionary", qualityTier: "Thématique risqué" },
  XPEV:  { name: "XPeng Inc.", type: "Véhicules Électriques / Chine ADR", sector: "Consumer Discretionary", qualityTier: "Thématique risqué" },
  GAP:   { name: "Gap Inc.", type: "Vêtements / Retail Mode", sector: "Consumer Discretionary", qualityTier: "Cyclique" },

  // ─── Consumer Staples ─────────────────────────────────────────────────────
  KO:   { name: "The Coca-Cola Co.", type: "Boissons / Défensif", sector: "Consumer Staples", qualityTier: "Core Quality" },
  MO:   { name: "Altria Group", type: "Tabac / Dividende Défensif", sector: "Consumer Staples", qualityTier: "Core Quality" },
  MDLZ: { name: "Mondelez International", type: "Alimentation / Snacks Global", sector: "Consumer Staples", qualityTier: "Core Quality" },
  KHC:  { name: "Kraft Heinz", type: "Alimentation / Condiments", sector: "Consumer Staples", qualityTier: "Cyclique" },
  LW:   { name: "Lamb Weston", type: "Alimentation / Pommes de Terre", sector: "Consumer Staples", qualityTier: "Cyclique" },
  KR:   { name: "Kroger", type: "Grande Distribution Alimentaire", sector: "Consumer Staples", qualityTier: "Core Quality" },
  KVUE: { name: "Kenvue", type: "Santé Consommateur / OTC", sector: "Consumer Staples", qualityTier: "Core Quality" },
  CELH:  { name: "Celsius Holdings Inc.", type: "Boissons Énergétiques / Consumer Growth", sector: "Consumer Staples", qualityTier: "Cyclique" },
  CPB:   { name: "The Campbell's Company", type: "Alimentation / Soupes & Sauces", sector: "Consumer Staples", qualityTier: "Core Quality" },
  UL:    { name: "Unilever PLC", type: "Produits Ménagers & Personnels / Global", sector: "Consumer Staples", qualityTier: "Core Quality" },

  // ─── Communication Services ───────────────────────────────────────────────
  NFLX:  { name: "Netflix Inc.", type: "Streaming / Contenu", sector: "Communication Services", qualityTier: "Core Quality" },
  WBD:   { name: "Warner Bros. Discovery", type: "Streaming / Médias", sector: "Communication Services", qualityTier: "Cyclique" },
  PINS:  { name: "Pinterest Inc.", type: "Réseaux Sociaux / Digital Advertising", sector: "Communication Services", qualityTier: "Cyclique" },
  VZ:    { name: "Verizon Communications", type: "Télécom US / Réseau Mobile", sector: "Communication Services", qualityTier: "Core Quality" },
  T:     { name: "AT&T", type: "Télécom US / Réseau Mobile & TV", sector: "Communication Services", qualityTier: "Core Quality" },
  CMCSA: { name: "Comcast", type: "Télécoms / Médias / Câble", sector: "Communication Services", qualityTier: "Core Quality" },
  BILI:  { name: "Bilibili Inc.", type: "Internet / Contenu Vidéo / Chine ADR", sector: "Communication Services", qualityTier: "Thématique risqué" },
  SIRI:  { name: "Sirius XM Holdings", type: "Radio Satellite / Audio Streaming", sector: "Communication Services", qualityTier: "Cyclique" },

  // ─── Énergie ──────────────────────────────────────────────────────────────
  SLB:  { name: "SLB (Schlumberger)", type: "Services Pétroliers", sector: "Energy", qualityTier: "Cyclique" },
  FSLR: { name: "First Solar Inc.", type: "Panneaux Solaires / Utility", sector: "Energy", qualityTier: "Cyclique" },
  KMI:  { name: "Kinder Morgan", type: "Pipelines / Midstream", sector: "Energy", qualityTier: "Core Quality" },
  VST:  { name: "Vistra Corp.", type: "Électricité / Énergie", sector: "Utilities", qualityTier: "Core Quality" },
  TECK: { name: "Teck Resources", type: "Mines / Cuivre / Zinc", sector: "Materials", qualityTier: "Cyclique" },
  NEM:  { name: "Newmont Corp.", type: "Mines / Or", sector: "Materials", qualityTier: "Cyclique" },
  CNQ:  { name: "Canadian Natural Resources", type: "Pétrole / Gaz Naturel Canada", sector: "Energy", qualityTier: "Cyclique" },
  DVN:  { name: "Devon Energy", type: "Pétrole / Gaz Naturel", sector: "Energy", qualityTier: "Cyclique" },
  OXY:  { name: "Occidental Petroleum", type: "Pétrole / Gaz / Pétrochimie", sector: "Energy", qualityTier: "Cyclique" },
  APA:  { name: "APA Corporation", type: "Pétrole / Gaz E&P", sector: "Energy", qualityTier: "Cyclique" },
  BP:   { name: "BP plc", type: "Majeure Pétrolière Intégrée", sector: "Energy", qualityTier: "Cyclique" },
  EQT:  { name: "EQT Corporation", type: "Gaz Naturel E&P", sector: "Energy", qualityTier: "Cyclique" },
  AR:   { name: "Antero Resources", type: "Gaz Naturel E&P", sector: "Energy", qualityTier: "Cyclique" },
  PBR:  { name: "Petróleo Brasileiro S.A. (Petrobras)", type: "Pétrole / Gaz / Brésil ADR", sector: "Energy", qualityTier: "Cyclique" },
  UEC:  { name: "Uranium Energy Corp.", type: "Uranium / Énergie Nucléaire", sector: "Energy", qualityTier: "Spéculatif favori" },

  // ─── Utilities ────────────────────────────────────────────────────────────
  PCG: { name: "PG&E Corp.", type: "Électricité / Gaz Californie", sector: "Utilities", qualityTier: "Core Quality" },
  NI:  { name: "NiSource Inc.", type: "Gaz Naturel / Électricité", sector: "Utilities", qualityTier: "Core Quality" },
  NEE: { name: "NextEra Energy", type: "Électricité / Éolien & Solaire", sector: "Utilities", qualityTier: "Core Quality" },
  SO:  { name: "Southern Company", type: "Électricité / Gaz SE États-Unis", sector: "Utilities", qualityTier: "Core Quality" },

  // ─── Santé ────────────────────────────────────────────────────────────────
  ABT:  { name: "Abbott Laboratories", type: "Dispositifs Médicaux", sector: "Healthcare", qualityTier: "Core Quality" },
  NVO:  { name: "Novo Nordisk A/S", type: "Pharma / GLP-1 / Diabète", sector: "Healthcare", qualityTier: "Core Quality" },
  INCY: { name: "Incyte Corp.", type: "Biotech / Oncologie", sector: "Healthcare", qualityTier: "Cyclique" },
  NBIX: { name: "Neurocrine Biosciences", type: "Biotech / Neurologie", sector: "Healthcare", qualityTier: "Cyclique" },
  CNC:  { name: "Centene Corporation", type: "Managed Healthcare / Assurance", sector: "Healthcare", qualityTier: "Cyclique" },
  TEVA: { name: "Teva Pharmaceutical Industries", type: "Génériques / Pharma", sector: "Healthcare", qualityTier: "Cyclique" },
  MRNA: { name: "Moderna", type: "Biotech / ARNm / Vaccins", sector: "Healthcare", qualityTier: "Spéculatif favori" },
  BMY:  { name: "Bristol-Myers Squibb", type: "Pharma / Oncologie & Immunologie", sector: "Healthcare", qualityTier: "Core Quality" },
  GEHC: { name: "GE HealthCare Technologies", type: "Imagerie Médicale / Dispositifs", sector: "Healthcare", qualityTier: "Cyclique" },
  BSX:  { name: "Boston Scientific", type: "Dispositifs Médicaux / Cardiologie", sector: "Healthcare", qualityTier: "Core Quality" },
  PFE:  { name: "Pfizer", type: "Pharma Diversifiée", sector: "Healthcare", qualityTier: "Cyclique" },
  MDT:  { name: "Medtronic", type: "Dispositifs Médicaux", sector: "Healthcare", qualityTier: "Core Quality" },

  // ─── Industrials ──────────────────────────────────────────────────────────
  CSX: { name: "CSX Corp.", type: "Transport Ferroviaire", sector: "Industrials", qualityTier: "Core Quality" },
  DAL: { name: "Delta Air Lines", type: "Aviation / Compagnie Aérienne", sector: "Industrials", qualityTier: "Cyclique" },
  AAL: { name: "American Airlines", type: "Aviation / Compagnie Aérienne", sector: "Industrials", qualityTier: "Cyclique" },
  UAL: { name: "United Airlines", type: "Aviation / Compagnie Aérienne", sector: "Industrials", qualityTier: "Cyclique" },
  UPS: { name: "United Parcel Service", type: "Logistique / Livraison", sector: "Industrials", qualityTier: "Core Quality" },
  LUV: { name: "Southwest Airlines", type: "Aviation Low-Cost", sector: "Industrials", qualityTier: "Cyclique" },
  QXO:  { name: "QXO Inc.", type: "Distribution Matériaux Construction / Tech", sector: "Industrials", qualityTier: "Spéculatif favori" },

  // ─── Matériaux ────────────────────────────────────────────────────────────
  CF:   { name: "CF Industries Holdings", type: "Engrais / Chimie Azotée", sector: "Materials", qualityTier: "Cyclique" },
  PAAS: { name: "Pan American Silver", type: "Mines / Argent & Or", sector: "Materials", qualityTier: "Cyclique" },
  CDE:  { name: "Coeur Mining", type: "Mines / Argent & Or", sector: "Materials", qualityTier: "Cyclique" },
  FCX:  { name: "Freeport-McMoRan", type: "Mines / Cuivre", sector: "Materials", qualityTier: "Cyclique" },
  DOW:  { name: "Dow Inc.", type: "Chimie / Matériaux", sector: "Materials", qualityTier: "Cyclique" },
  HL:   { name: "Hecla Mining", type: "Mines / Argent & Or", sector: "Materials", qualityTier: "Cyclique" },
  MP:   { name: "MP Materials", type: "Terres Rares / Matériaux Critiques", sector: "Materials", qualityTier: "Spéculatif favori" },
  USAR:  { name: "USA Rare Earth Inc.", type: "Terres Rares / Matériaux Critiques", sector: "Materials", qualityTier: "Spéculatif favori" },
  UUUU:  { name: "Energy Fuels Inc.", type: "Uranium / Terres Rares / Matériaux Critiques", sector: "Materials", qualityTier: "Spéculatif favori" },
  IP:    { name: "International Paper Co.", type: "Emballage Papier / Conteneurs", sector: "Materials", qualityTier: "Cyclique" },
  VALE:  { name: "Vale S.A.", type: "Mines / Minerai de Fer / Nickel / Brésil ADR", sector: "Materials", qualityTier: "Cyclique" },
  CLF:   { name: "Cleveland-Cliffs Inc.", type: "Acier / Sidérurgie", sector: "Materials", qualityTier: "Cyclique" },
  AG:    { name: "First Majestic Silver Corp.", type: "Mines / Argent", sector: "Materials", qualityTier: "Cyclique" },

  // ─── ETF Thématique / Matières premières ──────────────────────────────────
  SLV:  { name: "iShares Silver Trust", type: "ETF Argent", sector: "Commodities", qualityTier: "Thématique risqué" },
  XLE:  { name: "Energy Select Sector SPDR Fund", type: "Sector ETF Énergie", sector: "Energy", qualityTier: "Thématique risqué" },
  BNO:  { name: "United States Brent Oil Fund", type: "Commodity ETF Pétrole", sector: "Energy", qualityTier: "Thématique risqué" },
  EEM:  { name: "iShares MSCI Emerging Markets ETF", type: "Emerging Markets ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  XLP:  { name: "Consumer Staples Select Sector SPDR Fund", type: "Sector ETF Consommation de Base", sector: "ETF", qualityTier: "Thématique risqué" },
  ASHR: { name: "Xtrackers Harvest CSI 300 China A-Shares ETF", type: "China A-Shares ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  SCHD: { name: "Schwab U.S. Dividend Equity ETF", type: "Dividend ETF US", sector: "ETF", qualityTier: "Thématique risqué" },
  FXI:  { name: "iShares China Large-Cap ETF", type: "China Large-Cap ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  XLF:  { name: "Financial Select Sector SPDR Fund", type: "Sector ETF Finance", sector: "ETF", qualityTier: "Thématique risqué" },
  HYG:  { name: "iShares iBoxx $ High Yield Corporate Bond ETF", type: "High Yield Bond ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  KRE:  { name: "SPDR S&P Regional Banking ETF", type: "Regional Banking ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  XLB:  { name: "Materials Select Sector SPDR Fund", type: "Sector ETF Matériaux", sector: "ETF", qualityTier: "Thématique risqué" },
  GDX:  { name: "VanEck Gold Miners ETF", type: "Gold Miners ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  EWZ:  { name: "iShares MSCI Brazil ETF", type: "Brazil ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  XLU:  { name: "Utilities Select Sector SPDR Fund", type: "Sector ETF Utilities", sector: "ETF", qualityTier: "Thématique risqué" },
  FEZ:  { name: "SPDR EURO STOXX 50 ETF", type: "Euro STOXX 50 ETF", sector: "ETF", qualityTier: "Thématique risqué" },
  TLT:  { name: "iShares 20+ Year Treasury Bond ETF", type: "Treasury Bond ETF Long Duration", sector: "ETF", qualityTier: "Thématique risqué" },
  URA:   { name: "Global X Uranium ETF", type: "ETF Uranium / Énergie Nucléaire Thématique", sector: "ETF Thématique", qualityTier: "Thématique risqué" },
  MAGS:  { name: "Roundhill Magnificent Seven ETF", type: "ETF Mega-Cap Tech / Magnificent Seven", sector: "ETF Thématique", qualityTier: "Thématique risqué" },
  UNG:   { name: "United States Natural Gas Fund", type: "Commodity ETF Gaz Naturel", sector: "Commodities", qualityTier: "Thématique risqué" },
  XLC:   { name: "Communication Services Select Sector SPDR Fund", type: "Sector ETF Communication Services", sector: "ETF", qualityTier: "Thématique risqué" },
  LQD:   { name: "iShares iBoxx $ Investment Grade Corporate Bond ETF", type: "ETF Obligataire / Investment Grade Corporate", sector: "ETF", qualityTier: "Thématique risqué" },
  IEF:   { name: "iShares 7-10 Year Treasury Bond ETF", type: "ETF Obligataire / Treasuries 7-10 ans", sector: "ETF", qualityTier: "Thématique risqué" },

  // ─── Matières premières — Futures (traiter avec prudence) ─────────────────
  PL: { name: "Platinum Futures", type: "Futures / Contrat Platine", sector: "Commodities", qualityTier: "Thématique risqué" },
  CL: { name: "Crude Oil Futures", type: "Futures / Contrat Pétrole Brut", sector: "Commodities", qualityTier: "Thématique risqué" },

  // ─── Research Expanded — métadonnées enrichies ─────────────────────────────
  AA:    { name: "Alcoa Corp.", type: "Aluminium / Matériaux", sector: "Materials", qualityTier: "Cyclique" },
  AAOI:  { name: "Applied Optoelectronics", type: "Optique / Semi / Réseau", sector: "Technology", qualityTier: "Spéculatif favori" },
  AAP:   { name: "Advance Auto Parts", type: "Retail Automobile", sector: "Consumer Discretionary", qualityTier: "Cyclique" },
  ACHR:  { name: "Archer Aviation", type: "eVTOL / Aviation", sector: "Industrials", qualityTier: "Spéculatif favori" },
  ACN:   { name: "Accenture plc", type: "Services IT / Consulting", sector: "Technology", qualityTier: "Core Quality" },
  ACMR:  { name: "ACM Research", type: "Équipements Semi-conducteurs", sector: "Technology", qualityTier: "Cyclique" },
  ADBE:  { name: "Adobe Inc.", type: "Software Créatif / Cloud", sector: "Technology", qualityTier: "Core Quality" },
  ADI:   { name: "Analog Devices", type: "Semi-conducteurs Analogiques", sector: "Technology", qualityTier: "Core Quality" },
  AEHR:  { name: "Aehr Test Systems", type: "Équipements Test Semi", sector: "Technology", qualityTier: "Spéculatif favori" },
  AI:    { name: "C3.ai Inc.", type: "Logiciel IA Enterprise", sector: "Technology", qualityTier: "Spéculatif favori" },
  ALAB:  { name: "Astera Labs", type: "Semi / Connectivité IA Data Center", sector: "Technology", qualityTier: "Spéculatif favori" },
  AMAT:  { name: "Applied Materials", type: "Équipements Semi-conducteurs", sector: "Technology", qualityTier: "Core Quality" },
  ANET:  { name: "Arista Networks", type: "Réseau Data Center", sector: "Technology", qualityTier: "Core Quality" },
  APP:   { name: "AppLovin Corp.", type: "AdTech / Software Mobile", sector: "Technology", qualityTier: "Spéculatif favori" },
  APO:   { name: "Apollo Global Management", type: "Gestion alternative / Private Credit", sector: "Financial Services", qualityTier: "Core Quality" },
  ARES:  { name: "Ares Management", type: "Gestion d'Actifs Alternatifs", sector: "Financial Services", qualityTier: "Core Quality" },
  ARM:   { name: "Arm Holdings", type: "Semi IP CPU / Licences", sector: "Technology", qualityTier: "Core Quality" },
  ARKK:  { name: "ARK Innovation ETF", type: "ETF Innovation / High Beta", sector: "ETF Thématique", qualityTier: "Thématique risqué" },
  ASML:  { name: "ASML Holding", type: "Équipement Lithographie Semi", sector: "Technology", qualityTier: "Core Quality" },
  ASPI:  { name: "ASP Isotopes", type: "Isotopes / Nucléaire", sector: "Healthcare", qualityTier: "Spéculatif favori" },
  AUR:   { name: "Aurora Innovation", type: "Conduite Autonome", sector: "Technology", qualityTier: "Spéculatif favori" },
  AXTI:  { name: "AXT Inc.", type: "Matériaux Semi-conducteurs", sector: "Technology", qualityTier: "Cyclique" },
  AXP:   { name: "American Express", type: "Paiements / Crédit", sector: "Financial Services", qualityTier: "Core Quality" },
  BAX:   { name: "Baxter International", type: "Équipement Médical", sector: "Healthcare", qualityTier: "Core Quality" },
  BB:    { name: "BlackBerry Ltd.", type: "Cybersécurité / IoT / Software", sector: "Technology", qualityTier: "Cyclique" },
  BE:    { name: "Bloom Energy", type: "Énergie / Hydrogène / Fuel Cells", sector: "Energy", qualityTier: "Spéculatif favori" },
  BLSH:  { name: "Bullish", type: "Crypto Exchange / Fintech", sector: "Crypto", qualityTier: "Crypto bloqué" },
  BTDR:  { name: "Bitdeer Technologies", type: "Bitcoin Mining", sector: "Crypto", qualityTier: "Crypto bloqué" },
  BW:    { name: "Babcock & Wilcox", type: "Énergie / Industriel", sector: "Industrials", qualityTier: "Cyclique" },
  BX:    { name: "Blackstone Inc.", type: "Gestion d'Actifs Alternatifs", sector: "Financial Services", qualityTier: "Core Quality" },
  C:     { name: "Citigroup Inc.", type: "Banque globale", sector: "Financial Services", qualityTier: "Core Quality" },
  CAT:   { name: "Caterpillar Inc.", type: "Machinerie / Industriels", sector: "Industrials", qualityTier: "Core Quality" },
  CC:    { name: "The Chemours Co.", type: "Chimie / Matériaux", sector: "Materials", qualityTier: "Cyclique" },
  CDNS:  { name: "Cadence Design Systems", type: "EDA Software / Design Semi", sector: "Technology", qualityTier: "Core Quality" },
  CEG:   { name: "Constellation Energy", type: "Énergie Nucléaire / Utilities", sector: "Utilities", qualityTier: "Core Quality" },
  CIEN:  { name: "Ciena Corp.", type: "Réseau Optique", sector: "Technology", qualityTier: "Cyclique" },
  COHR:  { name: "Coherent Corp.", type: "Optique / Lasers / Semi", sector: "Technology", qualityTier: "Cyclique" },
  COPX:  { name: "Global X Copper Miners ETF", type: "ETF Cuivre / Matériaux", sector: "ETF", qualityTier: "Thématique risqué" },
  CRCL:  { name: "Circle Internet Group", type: "Crypto / Stablecoin / Fintech", sector: "Crypto", qualityTier: "Crypto bloqué" },
  CRDO:  { name: "Credo Technology Group", type: "Semi / Connectivité Data Center", sector: "Technology", qualityTier: "Spéculatif favori" },
  CRWD:  { name: "CrowdStrike Holdings", type: "Cybersécurité / Software", sector: "Technology", qualityTier: "Core Quality" },
  CSIQ:  { name: "Canadian Solar Inc.", type: "Solaire / Énergie", sector: "Energy", qualityTier: "Cyclique" },
  CSCO:  { name: "Cisco Systems", type: "Réseau / Infrastructure", sector: "Technology", qualityTier: "Core Quality" },
  DDOG:  { name: "Datadog Inc.", type: "Observabilité Cloud / Software", sector: "Technology", qualityTier: "Core Quality" },
  DOCN:  { name: "DigitalOcean Holdings", type: "Cloud Infrastructure", sector: "Technology", qualityTier: "Spéculatif favori" },
  IWM:   { name: "iShares Russell 2000 ETF", type: "ETF Small Caps / Russell 2000", sector: "ETF", qualityTier: "Thématique risqué" },
  MSTR:  { name: "MicroStrategy Inc.", type: "Logiciel / Bitcoin Treasury", sector: "Technology", qualityTier: "Spéculatif favori" },
  TSLA:  { name: "Tesla Inc.", type: "EV / Énergie / High Beta", sector: "Consumer Discretionary", qualityTier: "Spéculatif favori" },

  // ─── ETF Leveraged ────────────────────────────────────────────────────────
  SOXL: { name: "Direxion Daily Semiconductor Bull 3X Shares", type: "Leveraged ETF 3×", sector: "ETF à levier / Semi-conducteurs", qualityTier: "Spéculatif favori" },
  TNA:  { name: "Direxion Daily Small Cap Bull 3X Shares", type: "Leveraged ETF 3×", sector: "ETF à levier / Russell 2000", qualityTier: "Spéculatif favori" },
  SSO:  { name: "ProShares Ultra S&P500", type: "Leveraged ETF 2×", sector: "ETF à levier / S&P 500", qualityTier: "Spéculatif favori" },
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
    "BTDR", "BLSH", "CRCL",
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
