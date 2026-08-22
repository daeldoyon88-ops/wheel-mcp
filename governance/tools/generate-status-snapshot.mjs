import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalize, sha256Bytes } from './canonical-json.mjs';
import { validateLedger } from './validate-status-ledger.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

function option(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
}

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const ledgerPath = path.resolve(option('--ledger', path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')));
const outputPath = path.resolve(option('--output', path.join(root, 'governance', 'state', 'generated', 'GATE_STATUS_SNAPSHOT.json')));
const sourceMapPath = option('--source-map', null) ? path.resolve(option('--source-map')) : null;
const policyModulePath = option('--policy-module', null);
const check = process.argv.includes('--check');
const lifecycleStagingOnly = process.argv.includes('--lifecycle-staging-only');
let policy = WHEEL_EXTERNAL_AUTHORITY_POLICY;
if (policyModulePath) {
  const candidate = path.resolve(root, policyModulePath);
  const governanceRoot = path.resolve(root, 'governance') + path.sep;
  if (!candidate.startsWith(governanceRoot)) throw new Error('POLICY_MODULE_OUTSIDE_GOVERNANCE');
  const loaded = await import(`${pathToFileURL(candidate).href}?snapshotPolicy=${encodeURIComponent(sha256Bytes(fs.readFileSync(candidate)))}`);
  policy = loaded.default ?? loaded.policy;
  if (!policy || typeof policy !== 'object') throw new Error('POLICY_MODULE_INVALID');
}
const report = validateLedger({ root, ledgerPath, sourceMapPath, policy });
const ledgerInputReadable = !report.findings.some((finding) => ['MISSING_LEDGER', 'NDJSON_PARSE_ERROR'].includes(finding.detectorId));
if (!report.valid && !(lifecycleStagingOnly && ledgerInputReadable)) {
  process.stdout.write(JSON.stringify({ valid: false, stale: false, findings: report.findings }, null, 2) + '\n');
  process.exitCode = 2;
} else {
  const toolPath = fileURLToPath(import.meta.url);
  const byGate = new Map();
  for (const event of report.events) {
    byGate.set(event.gateId, {
      gateId: event.gateId,
      currentStatus: event.toStatus,
      lastEventId: event.eventId,
      lastEventOrdinal: event.ordinal,
      lastEventSha256: event.eventPayloadSha256,
      statusAuthorityPath: event.authorityPath,
      statusAuthoritySha256: event.authoritySha256
    });
  }
  const generatedAt = report.events.length ? report.events.at(-1).recordedAt : '1970-01-01T00:00:00.000Z';
  const snapshot = {
    schemaVersion: 1,
    canonical: false,
    generatedFrom: {
      sourceLedgerPath: path.relative(root, ledgerPath).replaceAll('\\', '/'),
      sourceLedgerSha256: report.ledgerSha256,
      generationTool: 'governance/tools/generate-status-snapshot.mjs',
      generationToolSha256: sha256Bytes(fs.readFileSync(toolPath)),
      provenance: 'Derived exclusively by replaying the canonical status ledger.'
    },
    generatedAt,
    gates: [...byGate.values()].sort((a, b) => a.gateId.localeCompare(b.gateId))
  };
  const bytes = Buffer.from(canonicalize(snapshot) + '\n', 'utf8');
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
  const stale = !existing || existing.length !== bytes.length || !crypto.timingSafeEqual(Buffer.from(existing), bytes);
  if (check) {
    process.stdout.write(JSON.stringify({ valid: true, stale, lifecycleStagingOnly, sourceLedgerSha256: report.ledgerSha256, outputPath: path.relative(root, outputPath).replaceAll('\\', '/') }, null, 2) + '\n');
    process.exitCode = stale ? 2 : 0;
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    atomicWrite(outputPath, bytes);
    process.stdout.write(JSON.stringify({ valid: true, stale: false, generated: true, lifecycleStagingOnly, outputPath: path.relative(root, outputPath).replaceAll('\\', '/'), sourceLedgerSha256: report.ledgerSha256 }, null, 2) + '\n');
  }
}
