/**
 * Read-only audit: verifies the earnings "expected move" multiplier is consistent
 * between the scan engine and the dashboard UI.
 *
 * Checks:
 *  1. No residual `* 1.8` earnings multiplier in the engine.
 *  2. The engine earnings multiplier (EARNINGS_EXPECTED_MOVE_MULTIPLIER) equals 2.
 *  3. The UI multiplier (expectedMoveMultiplier earnings branch) equals 2.
 *  4. No obvious conflict between adjustedMove (engine) and the UI multiplier.
 *
 * No data is written. Pure inspection. Exit code 0 = COHERENT, 1 = INCOHERENT.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const ENGINE_FILE = join(repoRoot, "app", "scanners", "wheelScanner.js");
const UI_DASHBOARD = join(repoRoot, "wheel-dashboard", "src", "dashboard.jsx");
const UI_BUILDER = join(repoRoot, "wheel-dashboard", "src", "buildWheelShortlist.js");

const inspected = [ENGINE_FILE, UI_DASHBOARD, UI_BUILDER];

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    return null;
  }
}

const problems = [];

// --- Engine ---
const engineSrc = read(ENGINE_FILE) ?? "";
let engineMultiplier = null;

const constMatch = engineSrc.match(/EARNINGS_EXPECTED_MOVE_MULTIPLIER\s*=\s*([0-9.]+)/);
if (constMatch) {
  engineMultiplier = Number(constMatch[1]);
} else {
  problems.push("Constante EARNINGS_EXPECTED_MOVE_MULTIPLIER introuvable dans le moteur.");
}

// adjustedMove must use the constant in its earnings branch.
const usesConstant = /adjustedMove[\s\S]{0,80}EARNINGS_EXPECTED_MOVE_MULTIPLIER/.test(engineSrc);
if (!usesConstant) {
  problems.push("adjustedMove n'utilise pas EARNINGS_EXPECTED_MOVE_MULTIPLIER.");
}

// No residual 1.8 earnings multiplier near expectedMove/adjustedMove.
const residual18 = /expectedMoveAbs\s*\*\s*1\.8/.test(engineSrc);
if (residual18) {
  problems.push("Résidu détecté : `expectedMoveAbs * 1.8` toujours présent dans le moteur.");
}

if (engineMultiplier != null && engineMultiplier !== 2) {
  problems.push(`Multiplicateur moteur attendu 2, trouvé ${engineMultiplier}.`);
}

// --- UI dashboard ---
const dashSrc = read(UI_DASHBOARD) ?? "";
let uiMultiplier = null;
const uiMatch = dashSrc.match(/expectedMoveMultiplier:\s*\w+\s*\?\s*([0-9.]+)\s*:\s*[0-9.]+/);
if (uiMatch) {
  uiMultiplier = Number(uiMatch[1]);
} else {
  problems.push("Branche earnings expectedMoveMultiplier introuvable dans le dashboard.");
}
if (uiMultiplier != null && uiMultiplier !== 2) {
  problems.push(`Multiplicateur UI attendu 2, trouvé ${uiMultiplier}.`);
}

// UI x2 label sanity (documentation strings).
const hasX2Label = /expected move x2/i.test(dashSrc);
if (!hasX2Label) {
  problems.push("Libellé documentaire « expected move x2 » introuvable (vérifier l'UI).");
}

// --- Client builder (must stay aligned) ---
const builderSrc = read(UI_BUILDER) ?? "";
const builderMatch = builderSrc.match(/hasEarnings\s*\?\s*expectedMove\s*\*\s*([0-9.]+)/);
const builderMultiplier = builderMatch ? Number(builderMatch[1]) : null;
if (builderMultiplier != null && builderMultiplier !== 2) {
  problems.push(`buildWheelShortlist multiplicateur attendu 2, trouvé ${builderMultiplier}.`);
}

// --- Cross-check engine vs UI ---
if (engineMultiplier != null && uiMultiplier != null && engineMultiplier !== uiMultiplier) {
  problems.push(
    `Conflit moteur/UI : moteur=${engineMultiplier} vs UI=${uiMultiplier}.`
  );
}

const coherent = problems.length === 0;

console.log("=== Audit cohérence multiplicateur earnings expected move ===");
console.log(`Multiplicateur moteur (scanner)      : ${engineMultiplier ?? "introuvable"}`);
console.log(`Multiplicateur UI (dashboard)        : ${uiMultiplier ?? "introuvable"}`);
console.log(`Multiplicateur builder client        : ${builderMultiplier ?? "n/a"}`);
console.log(`Résidu x1.8 dans le moteur           : ${residual18 ? "OUI" : "non"}`);
console.log("");
console.log("Fichiers inspectés :");
for (const f of inspected) console.log(`  - ${f.replace(repoRoot + "\\", "").replace(repoRoot + "/", "")}`);
console.log("");
if (!coherent) {
  console.log("Problèmes détectés :");
  for (const p of problems) console.log(`  ! ${p}`);
  console.log("");
}
console.log(`VERDICT : ${coherent ? "COHÉRENT" : "INCOHÉRENT"}`);

process.exit(coherent ? 0 : 1);
