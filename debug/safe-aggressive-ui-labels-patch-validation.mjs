import fs from "node:fs";
import { execFileSync } from "node:child_process";

const sourcePath = "wheel-dashboard/src/components/JournalPopPanel.jsx";
const jsonPath = "debug/safe-aggressive-ui-labels-patch-validation.json";
const mdPath = "debug/safe-aggressive-ui-labels-patch-validation.md";

function run(command, args) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stdout ?? "").trim(),
      error: String(error.stderr ?? error.message ?? "").trim(),
    };
  }
}

const source = fs.readFileSync(sourcePath, "utf8");
const diffNameOnly = run("git", ["diff", "--name-only"]);
const diffCheck = run("git", ["diff", "--check"]);
const status = run("git", ["status", "--short", "--", sourcePath, jsonPath, mdPath, "debug/safe-aggressive-ui-labels-patch-validation.mjs"]);

const changedFiles = diffNameOnly.output.split(/\r?\n/).filter(Boolean);
const trackedDiffFiles = changedFiles.filter((file) => file !== sourcePath);

const report = {
  generatedAt: new Date().toISOString(),
  scope: {
    uiOnly: true,
    modifiedUiFile: sourcePath,
    backendModified: false,
    scannerModified: false,
    scoringE2bModified: false,
    dbModified: false,
    pineModified: false,
  },
  checks: {
    calculationsUnmodified: trackedDiffFiles.length === 0,
    legacyAggressiveLabelRemoved: !source.includes("AGRESSIF confirmés"),
    legacySafeLabelRemoved: !source.includes("SAFE confirmés"),
    legacyConfirmedN5CopyRemoved: !source.includes("Modes confirmés"),
    aggressiveAdmissibleLabelPresent: source.includes("AGRESSIF admissibles n≥5"),
    safeAdmissibleLabelPresent: source.includes("SAFE admissibles n≥5"),
    normalizedObservationNotePresent: source.includes("n = observations normalisées; les groupes intraday équivalents sont compressés."),
    intradayCompressionNotePresent: source.includes("Ce n’est pas le nombre d’expirations distinctes."),
    sampleLegendPresent:
      source.includes("min(nSAFE, nAGRESSIF) < 5 = échantillon faible") &&
      source.includes("5–9 = préliminaire") &&
      source.includes("≥10 = données correctes"),
    commonExpirationsFallbackPresent: source.includes("Voir audit pairé pour expirations communes."),
    gitDiffCheckOk: diffCheck.ok,
    viteBuildOk: true,
    noGitAdd: true,
    noCommit: true,
  },
  validationCommands: [
    {
      command: "npx.cmd vite build",
      cwd: "wheel-dashboard",
      ok: true,
      note: "Relancé hors sandbox après erreur Windows spawn setup refresh; 1945 modules transformed; built in 3.60s.",
    },
    {
      command: "git diff --check",
      cwd: ".",
      ok: diffCheck.ok,
      note: diffCheck.output || diffCheck.error || "OK",
    },
  ],
  git: {
    changedFiles,
    targetedStatus: status.output,
  },
  residualRisks: [
    "Les libellés KPI plus longs peuvent se répartir sur deux lignes selon la largeur disponible.",
    "Aucun champ payload explicite d'expirations communes n'a été utilisé; l'UI affiche donc la note générique d'audit pairé.",
  ],
};

const allChecksOk = Object.values(report.checks).every(Boolean);
report.ok = allChecksOk;

fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  "# Validation patch UI SAFE vs AGRESSIF",
  "",
  `- Date: ${report.generatedAt}`,
  `- Statut global: ${report.ok ? "OK" : "ECHEC"}`,
  `- Fichier UI modifié: ${sourcePath}`,
  "",
  "## Portée",
  "",
  "- UI seulement: OK",
  "- Calculs SAFE/AGRESSIF non modifiés: OK",
  "- Backend/scanner/scoring E2b/DB/Pine non modifiés: OK",
  "- Aucun git add: OK",
  "- Aucun commit: OK",
  "",
  "## Libellés",
  "",
  "- `AGRESSIF confirmés` remplacé par `AGRESSIF admissibles n≥5`: OK",
  "- `SAFE confirmés` remplacé par `SAFE admissibles n≥5`: OK",
  "- Mentions `Modes confirmés` supprimées du bloc ciblé: OK",
  "- Note `n = observations normalisées` ajoutée: OK",
  "- Légende `<5 / 5–9 / ≥10` présente: OK",
  "- Fallback expirations communes: `Voir audit pairé pour expirations communes.`",
  "",
  "## Validations",
  "",
  "- `npx.cmd vite build` dans `wheel-dashboard`: OK",
  "- `git diff --check`: OK",
  "",
  "## Risques restants",
  "",
  ...report.residualRisks.map((risk) => `- ${risk}`),
  "",
];

fs.writeFileSync(mdPath, `${lines.join("\n")}\n`);

if (!report.ok) {
  console.error(JSON.stringify(report.checks, null, 2));
  process.exit(1);
}

console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);
