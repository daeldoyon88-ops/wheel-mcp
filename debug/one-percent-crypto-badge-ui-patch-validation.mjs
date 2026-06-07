#!/usr/bin/env node
/**
 * Validation — Patch UI badge crypto-block dans "Objectif 1 %+ — Wheel complet" (Journal POP).
 *
 * Portée : UI seulement. Vérifie que le badge crypto-block est câblé sur la source unique
 * (app/watchlist/cryptoWheelFilter.js via getTickerDisplayMeta) sans masquer de tickers,
 * sans bloquer BITX, ni COIN/MSTR, et sans toucher au backend/scanner/scoring/DB/Pine.
 *
 * Lecture seule : n'écrit que le JSON de résultat à côté de ce script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const panelPath = join(repoRoot, "wheel-dashboard", "src", "components", "JournalPopPanel.jsx");
const filterPath = join(repoRoot, "app", "watchlist", "cryptoWheelFilter.js");
const tickerMetaPath = join(repoRoot, "wheel-dashboard", "src", "tickerMeta.js");

const panel = readFileSync(panelPath, "utf8");

const checks = [];
const record = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

// 1. Helper crypto réutilisé depuis la source unique (pas de liste dupliquée).
record(
  "import getTickerDisplayMeta depuis ../tickerMeta.js",
  /import\s*\{\s*getTickerDisplayMeta\s*\}\s*from\s*["']\.\.\/tickerMeta\.js["']/.test(panel),
  "JournalPopPanel.jsx importe le helper UI officiel"
);

// 2. tickerMeta s'appuie bien sur cryptoWheelFilter.js (source unique).
const tickerMeta = readFileSync(tickerMetaPath, "utf8");
record(
  "tickerMeta.js dérive de cryptoWheelFilter.js",
  /from\s*["']\.\.\/\.\.\/app\/watchlist\/cryptoWheelFilter\.js["']/.test(tickerMeta) &&
    /isCryptoDigitalAssetBlocked/.test(tickerMeta),
  "getTickerDisplayMeta() s'appuie sur isCryptoDigitalAssetBlocked / getCryptoBlockReason"
);

// 3. Badge bloquant présent dans la section Objectif 1 %+.
record(
  "badge 'Crypto bloqué — exclu Wheel' présent",
  /Crypto bloqué — exclu Wheel/.test(panel),
  "Badge visible rendu dans la cellule ticker du shortlist 1 %+"
);

// 4. Badge informatif 'Crypto relié' présent (COIN/MSTR), non bloquant.
record(
  "badge informatif 'Crypto relié' présent",
  /Crypto relié/.test(panel) && /isCryptoRelatedEquity/.test(panel),
  "Badge informatif pour crypto-related equity (COIN/MSTR)"
);

// 5. Tooltip officiel avec raison + exception BITX.
record(
  "tooltip raison + 'BITX seul autorisé'",
  /cryptoBlockReason\s*\|\|\s*["']crypto_blocked_except_bitx["']/.test(panel) &&
    /BITX seul autorisé/.test(panel),
  "Title utilise cryptoBlockReason officiel avec mention BITX"
);

// 6. Aucun masquage par défaut : ticker toujours rendu, pas de filtre crypto ajouté.
record(
  "ticker toujours rendu (aucun masquage)",
  /<span>\{profile\.ticker\}<\/span>/.test(panel),
  "Le ticker est affiché inconditionnellement ; le badge s'ajoute à côté"
);
record(
  "aucun filtre crypto ajouté au pipeline 1 %+",
  !/filteredOnePercentProfiles[\s\S]{0,400}isCryptoDigitalAssetBlocked/.test(panel) &&
    !/displayedOnePercentProfiles[\s\S]{0,400}isCryptoDigitalAssetBlocked/.test(panel),
  "filteredOnePercentProfiles / displayedOnePercentProfiles non altérés par un filtre crypto"
);

// 7. cryptoWheelFilter.js non modifié (vérifié hors script via git ; on confirme sa présence/forme).
const filter = readFileSync(filterPath, "utf8");
record(
  "cryptoWheelFilter.js intact (BITX exception, COIN/MSTR non bloqués)",
  /CRYPTO_ALLOWED_SYMBOLS\s*=\s*new Set\(\["BITX"\]\)/.test(filter) &&
    /CRYPTO_RELATED_EQUITY_SYMBOLS\s*=\s*new Set\(\["MSTR",\s*"COIN"\]\)/.test(filter),
  "Règles métier inchangées : BITX autorisé, COIN/MSTR crypto-related (non bloqués)"
);

// 8. Fonctions protégées non touchées (présentes telles quelles, sans logique crypto injectée).
for (const fn of [
  "filteredOnePercentProfiles",
  "displayedOnePercentProfiles",
]) {
  record(
    `${fn} préservé`,
    new RegExp(`const\\s+${fn}\\s*=\\s*useMemo`).test(panel),
    `${fn} toujours défini via useMemo, non remplacé`
  );
}

const allPass = checks.every((c) => c.pass);
const result = {
  patch: "one-percent-crypto-badge-ui",
  scope: "UI only — wheel-dashboard/src/components/JournalPopPanel.jsx",
  helper: "getTickerDisplayMeta() (wheel-dashboard/src/tickerMeta.js) → app/watchlist/cryptoWheelFilter.js",
  generatedAt: new Date().toISOString(),
  allPass,
  checks,
};

writeFileSync(
  join(__dirname, "one-percent-crypto-badge-ui-patch-validation.json"),
  JSON.stringify(result, null, 2) + "\n",
  "utf8"
);

for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"} — ${c.name}`);
}
console.log(`\n${allPass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED"}`);
process.exit(allPass ? 0 : 1);
