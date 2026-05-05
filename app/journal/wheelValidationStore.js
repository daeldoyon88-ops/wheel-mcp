import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_JOURNAL_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.json");

function createEmptyJournal() {
  return {
    version: "1.0",
    updatedAt: null,
    records: [],
  };
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function createWheelValidationStore(journalPath = DEFAULT_JOURNAL_PATH) {
  async function load() {
    try {
      const raw = await fs.readFile(journalPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return createEmptyJournal();
      if (!Array.isArray(parsed.records)) parsed.records = [];
      if (!parsed.version) parsed.version = "1.0";
      if (!Object.prototype.hasOwnProperty.call(parsed, "updatedAt")) parsed.updatedAt = null;
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return createEmptyJournal();
      throw error;
    }
  }

  async function save(journal) {
    await ensureParentDir(journalPath);
    const normalized = {
      version: journal?.version ?? "1.0",
      updatedAt: journal?.updatedAt ?? new Date().toISOString(),
      records: Array.isArray(journal?.records) ? journal.records : [],
    };
    await writeJsonAtomic(journalPath, normalized);
    return normalized;
  }

  return {
    load,
    save,
    journalPath,
  };
}
