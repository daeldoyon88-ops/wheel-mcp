#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const POLICY = 'governance/gates/GATE19/implementation/BUNDLE_POLICY.json';
const MANIFEST = 'governance/gates/GATE19/evidence/BUNDLE_MANIFEST.json';
const SELFTEST = 'governance/gates/GATE19/evidence/FINAL_ZIP_SELFTEST.json';
const RECEIPT = 'governance/gates/GATE19/evidence/DETACHED_TERMINAL_VERIFICATION_RECEIPT.json';

function bytes(relative) { return fs.readFileSync(path.join(ROOT, ...relative.split('/'))); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function json(relative) { return JSON.parse(bytes(relative).toString('utf8')); }
function governed(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value) { const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }
function zipStore(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.packagePath, 'utf8'); const body = entry.bytes; const crc = crc32(body);
    const header = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(body.length), u32(body.length), u16(name.length), u16(0), name]);
    local.push(header, body); offset += header.length + body.length;
    central.push({ name, crc, size: body.length, offset: offset - header.length - body.length });
  }
  const centralBytes = [];
  for (const entry of central) centralBytes.push(Buffer.concat([Buffer.from('PK\x01\x02', 'binary'), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(entry.crc), u32(entry.size), u32(entry.size), u16(entry.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.offset), entry.name]));
  const centralBody = Buffer.concat(centralBytes); const localBody = Buffer.concat(local);
  const end = Buffer.concat([Buffer.from('PK\x05\x06', 'binary'), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBody.length), u32(localBody.length), u16(0)]);
  return Buffer.concat([localBody, centralBody, end]);
}
function readZipEntries(archive) {
  const entries = []; let offset = 0;
  while (offset + 4 <= archive.length && archive.toString('binary', offset, offset + 4) === 'PK\x03\x04') {
    const nameLength = archive.readUInt16LE(offset + 26); const extraLength = archive.readUInt16LE(offset + 28); const size = archive.readUInt32LE(offset + 18);
    const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength); const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, bytes: archive.subarray(start, start + size) }); offset = start + size;
  }
  return entries;
}
function pathChecks(names, prefix) {
  const duplicate = names.length - new Set(names).size;
  return {
    BACKSLASH_ENTRIES: names.filter((name) => name.includes('\\')).length,
    OUTSIDE_PACKAGE_PREFIX: names.filter((name) => !name.startsWith(prefix)).length,
    UNSAFE_PATHS: names.filter((name) => name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.')).length,
    DUPLICATE_ENTRIES: duplicate
  };
}
function build() {
  const policy = json(POLICY); const selected = policy.selectedArtifacts.map((item) => ({ ...item, bytes: bytes(item.sourcePath) }));
  const archive = zipStore(selected);
  const archiveRelative = policy.archivePath;
  const archiveSha256 = sha256(archive);
  const manifest = {
    document: 'BUNDLE_MANIFEST', schemaVersion: 1, gateId: 'GATE19', packagePrefix: policy.packagePrefix,
    archivePath: archiveRelative, archiveSha256, archiveByteLength: archive.length,
    entries: selected.map((item) => ({ packagePath: item.packagePath, sourcePath: item.sourcePath, sha256: sha256(item.bytes), byteLength: item.bytes.length }))
  };
  const entryNames = readZipEntries(archive).map((entry) => entry.name); const checks = pathChecks(entryNames, policy.packagePrefix);
  const selfTest = {
    document: 'FINAL_ZIP_SELFTEST', schemaVersion: 1, gateId: 'GATE19', verdict: Object.values(checks).every((value) => value === 0) ? 'PASS' : 'FAIL',
    checks: { ...checks, MANIFEST_BYTES: entryNames.length === manifest.entries.length && manifest.entries.every((entry) => entryNames.includes(entry.packagePath)) ? 0 : 1, REPOSITORY_EXCLUDED: entryNames.some((name) => name === 'repository/' || name.includes('node_modules/')) ? 1 : 0 },
    archiveSha256, entryCount: entryNames.length
  };
  selfTest.verdict = Object.values(selfTest.checks).every((value) => value === 0) ? 'PASS' : 'FAIL';
  const manifestBytes = governed(manifest); const selfTestBytes = governed(selfTest);
  const receipt = {
    document: 'DETACHED_TERMINAL_VERIFICATION_RECEIPT', schemaVersion: 1, gateId: 'GATE19', verdict: selfTest.verdict,
    archivePath: archiveRelative, manifestPath: MANIFEST, selfTestPath: SELFTEST,
    archiveSha256, manifestSha256: sha256(manifestBytes), selfTestSha256: sha256(selfTestBytes), evidenceMode: 'DETACHED_BYTE_VERIFICATION'
  };
  return { policy, archive, manifestBytes, selfTestBytes, receiptBytes: governed(receipt), archiveRelative };
}
export function verifyExisting() {
  const built = build(); const archive = bytes(built.archiveRelative); const manifest = bytes(MANIFEST); const selfTest = bytes(SELFTEST); const receipt = json(RECEIPT);
  return built.archive.equals(archive) && built.manifestBytes.equals(manifest) && built.selfTestBytes.equals(selfTest) && receipt.verdict === 'PASS' && receipt.archiveSha256 === sha256(archive);
}
export function buildBundle() {
  const built = build(); const archivePath = path.join(ROOT, ...built.archiveRelative.split('/'));
  for (const [relative, body] of [[built.archiveRelative, built.archive], [MANIFEST, built.manifestBytes], [SELFTEST, built.selfTestBytes], [RECEIPT, built.receiptBytes]]) { const target = path.join(ROOT, ...relative.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); }
  return { archiveSha256: sha256(built.archive), verdict: JSON.parse(built.selfTestBytes).verdict, archivePath };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check'); const result = check ? { document: 'GATE19_BUNDLE_CHECK', verdict: verifyExisting() ? 'PASS' : 'FAIL' } : { document: 'GATE19_BUNDLE_BUILD', ...buildBundle() };
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.verdict === 'PASS' ? 0 : 2;
}
export { readZipEntries, pathChecks };
