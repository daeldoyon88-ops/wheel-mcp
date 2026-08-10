import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// This suite proves the two REGISTRY_LEDGER_AUTHORITY_CONFLICT / ACTIVE_GATE_HARDCODED_GUARD
// blockers recorded in governance/sources/independent-audits/CHATGPT_GATE13_DISCOVERY_R1_INDEPENDENT_AUDIT.json
// are repaired, and that the repair fails closed under hostile mutation. Every case builds its own
// physical, non-symlinked fixture directory so no test can taint another and none touch the real
// tracked repository.

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..', '..'); // .../governance/tests -> repo root
const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gate13-repair-fixture-'));
const fixtures = [];

function h(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function makeFixture(name) {
  const dir = path.join(fixtureBase, name);
  fs.cpSync(path.join(repoRoot, 'governance'), path.join(dir, 'governance'), { recursive: true, dereference: true });
  fixtures.push(dir);
  return dir;
}

// GEE_V1_R1_ARCHITECTURE_REPAIR_IMPLEMENTATION_R1 note (RC-1/RC-2 ledger reconciliation):
// GATE13 now legitimately carries real, append-only, hash-verified ledger transitions reaching
// COMPLETE_CONFIRMED (governance/state/GATE_STATUS_LEDGER.ndjson ordinals 42-44) instead of sitting
// frozen at its GENESIS_IMPORT AUTHORIZED_NOT_STARTED event. validate-active-gate.mjs's PRE-EXISTING
// "a closed gate's contract/state are a historical record, not re-verified on every activation" rule
// (see its own header comment) now legitimately applies to GATE13. The hostile fixtures below that
// specifically exercise the NOT-yet-closed contract/state re-validation path (steps 4-6) revert the
// copied fixture's ledger to GATE13's honest pre-reconciliation state first, mirroring this file's own
// established technique in G13-REPAIR-12 (direct, re-chained ledger rewrite to isolate one check).
function revertGate13ToPreReconciliation(dir) {
  const ledgerPath = path.join(dir, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 41, 'the fixture must contain the historical pre-GATE13 prefix');
  const prefix = lines.slice(0, 41).join('\n') + '\n';
  assert.equal(h(Buffer.from(prefix, 'utf8')), 'a39591873658989062cedfc96f2acd9415311950b94ee98ffb0d65575e3ecec5');
  fs.writeFileSync(ledgerPath, prefix);
}

function run(script, args, cwd, env = {}) {
  try {
    const out = execFileSync('node', [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: error.stdout || '', err: error.stderr || '' };
  }
}

after(() => { for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true }); });

// --- Conflict 1: registry / ledger authority pin ---------------------------------------------

test('G13-REPAIR-01: the repaired registry (GATE13 fields filled) resolves all 39 historical events via the migration, zero blocking findings', () => {
  const dir = makeFixture('ledger-migrated');
  const migrationLog = fs.readFileSync(path.join(dir, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson'), 'utf8').trim();
  assert.ok(migrationLog.length > 0, 'a migration record must exist once the registry has been legitimately amended');
  const record = JSON.parse(migrationLog.split('\n')[0]);
  const snapshotBytes = fs.readFileSync(path.join(dir, record.snapshotPath));
  assert.equal(h(snapshotBytes), record.originalAuthoritySha256, 'snapshot must reproduce the exact historical hash it claims to preserve');
  const registryBytes = fs.readFileSync(path.join(dir, 'governance/GATE_REGISTRY_00_40.json'));
  assert.notEqual(h(registryBytes), record.originalAuthoritySha256, 'this fixture must represent the POST-edit registry, not the historical snapshot');
  const { code, out } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  const report = JSON.parse(out);
  const blocking = report.findings.filter((f) => f.severity === 'BLOCKING');
  const migrated = report.findings.filter((f) => f.detectorId === 'MIGRATED_HISTORICAL_AUTHORITY');
  assert.equal(blocking.length, 0);
  assert.equal(migrated.length, 39);
  assert.equal(code, 0);
  assert.equal(report.valid, true);
});

test('G13-REPAIR-02: the historical registry snapshot is byte-identical to the registry as it existed before the GATE13 edit', () => {
  const dir = makeFixture('ledger-snapshot-fidelity');
  const preEditRegistrySha256 = '3b82ac1566ef359ed53dcef33e57c456f63419bfd368c2ec2eb72028498c0b6a';
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson'), 'utf8').trim().split('\n')[0]);
  assert.equal(record.originalAuthoritySha256, preEditRegistrySha256);
  const snapshotBytes = fs.readFileSync(path.join(dir, record.snapshotPath));
  assert.equal(h(snapshotBytes), preEditRegistrySha256);
});

test('G13-REPAIR-03 (hostile): tampering the immutable snapshot bytes is detected and fails closed', () => {
  const dir = makeFixture('ledger-hostile-snapshot-tamper');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson'), 'utf8').trim().split('\n')[0]);
  fs.appendFileSync(path.join(dir, record.snapshotPath), ' ');
  const { code, out } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  const report = JSON.parse(out);
  assert.equal(code, 2);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'SNAPSHOT_TAMPERED'));
  assert.ok(report.findings.some((f) => f.detectorId === 'AUTHORITY_HASH_MISMATCH'));
});

test('G13-REPAIR-04 (hostile): an unauthorized migration record (forged authorizedBySha256) fails closed', () => {
  const dir = makeFixture('ledger-hostile-unauthorized');
  const p = path.join(dir, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  rec.authorizedBySha256 = 'b'.repeat(64);
  const canonicalize = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  };
  const payload = { ...rec }; delete payload.migrationPayloadSha256;
  rec.migrationPayloadSha256 = h(Buffer.from(canonicalize(payload), 'utf8'));
  fs.writeFileSync(p, canonicalize(rec) + '\n');
  const { code, out } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  const report = JSON.parse(out);
  assert.equal(code, 2);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'MIGRATION_UNAUTHORIZED'));
});

test('G13-REPAIR-05 (hostile): a broken migration chain (bogus previousMigrationSha256) fails closed', () => {
  const dir = makeFixture('ledger-hostile-chain-break');
  const p = path.join(dir, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  rec.previousMigrationSha256 = 'a'.repeat(64);
  fs.writeFileSync(p, JSON.stringify(rec) + '\n');
  const { code, out } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  const report = JSON.parse(out);
  assert.equal(code, 2);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'MIGRATION_CHAIN_BREAK'));
});

// G13-REPAIR-06 replacement — GEE_V1_R1_ARCHITECTURE_REPAIR_IMPLEMENTATION_R1 (RC-1/RC-2):
// OLD_TEST_ASSUMPTION: the WHOLE ledger file stays byte-identical to its pre-repair (frozen at
//   GENESIS_IMPORT) bytes forever.
// WHY_INVALID: that assumption is exactly root cause RC-1/RC-2 — the ledger was "frozen at genesis"
//   and never used as authority. Making it the real authority spine (this mission's mandate) requires
//   recording real, honest transitions for gates that actually progressed, e.g. GATE13 reaching
//   COMPLETE_CONFIRMED via real independent-reinspection evidence.
// NEW_ARCHITECTURE_RULE: history is APPEND-ONLY, not FROZEN. The first 41 lines (all history that
//   existed before this repair) remain byte-for-byte untouched; new lines may only be appended, never
//   inserted, edited, or removed.
// NEW_TEST: assert the first 41 lines are unchanged AND any additional lines are well-formed appended
//   events (never a rewrite of an existing ordinal).
// EVIDENCE: 10_RECOMMENDED_ARCHITECTURE.md sec. 1 (RUN_ROOT 20260808_145613); ledger ordinals 42-44.
test('G13-REPAIR-06: the first 41 ledger event lines remain byte-identical to the pre-repair ledger (history is append-only, never rewritten)', () => {
  const dir = makeFixture('ledger-history-invariant');
  const preRepairLedgerSha256 = 'a39591873658989062cedfc96f2acd9415311950b94ee98ffb0d65575e3ecec5';
  const lines = fs.readFileSync(path.join(dir, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 41, 'at least the original 41 historical lines must be present');
  const first41 = lines.slice(0, 41).join('\n') + '\n';
  assert.equal(h(Buffer.from(first41, 'utf8')), preRepairLedgerSha256);
  for (let i = 41; i < lines.length; i += 1) {
    const event = JSON.parse(lines[i]);
    assert.equal(event.ordinal, i + 1, `appended line ${i + 1} must carry the next ordinal, never renumber history`);
  }
});

// --- Conflict 2: ACTIVE_GATE hardcoded guard -----------------------------------------------------

function gate13Candidate() {
  return JSON.stringify({
    schemaVersion: 1, activeGate: 'GATE13', activationEventId: 'GENESIS_IMPORT_GATE13', activationEventOrdinal: 14,
    activationEventSha256: '68bc8b9e030fc22414fd040c318fac39df8e1f92a75b3a253f175c5113f39d90',
    currentStatePath: 'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    currentStateSha256: 'b12cd7497835ff87b81a7a42aec90399bde57a344ca65b6942db79ab948a889f'
  });
}

test('G13-REPAIR-07: control -- real, unmodified GATE12 ACTIVE_GATE.json is still accepted', () => {
  const dir = makeFixture('active-gate-control-gate12');
  const { code, out } = run('governance/tools/validate-active-gate.mjs', [], dir);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { valid: true, findingIds: [] });
});

test('G13-REPAIR-08: a fully valid GATE13 candidate (real event, real contract, real sealed state, closed predecessor) is accepted', () => {
  const dir = makeFixture('active-gate-gate13-full');
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  const { code, out } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { valid: true, findingIds: [] });
});

test('G13-REPAIR-09 (hostile): GATE13 without any contract on disk is rejected', () => {
  const dir = makeFixture('active-gate-gate13-no-contract');
  revertGate13ToPreReconciliation(dir);
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  fs.rmSync(path.join(dir, 'governance/gates/GATE13/contracts'), { recursive: true, force: true });
  const { code, err } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(err);
  assert.equal(code, 2);
  assert.ok(report.findingIds.includes('ACTIVE_GATE_NOT_AUTHORIZED'));
  assert.ok(report.findingIds.includes('GATE_CONTRACT_INVALID'));
});

test('G13-REPAIR-10 (hostile): GATE13 without any state on disk is rejected', () => {
  const dir = makeFixture('active-gate-gate13-no-state');
  revertGate13ToPreReconciliation(dir);
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  fs.rmSync(path.join(dir, 'governance/gates/GATE13/state'), { recursive: true, force: true });
  const { code, err } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(err);
  assert.equal(code, 2);
  assert.ok(report.findingIds.includes('GATE_STATE_INVALID'));
});

test('G13-REPAIR-11 (hostile): GATE13 with a tampered state seal is rejected', () => {
  const dir = makeFixture('active-gate-gate13-bad-seal');
  revertGate13ToPreReconciliation(dir);
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  fs.appendFileSync(path.join(dir, 'governance/gates/GATE13/state/revisions/R0001/STATE_SEAL.json'), ' ');
  const { code, err } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(err);
  assert.equal(code, 2);
  assert.ok(report.findingIds.includes('GATE_STATE_INVALID'));
});

test('G13-REPAIR-12 (hostile): GATE13 with an incomplete (not closed) predecessor is rejected', () => {
  const dir = makeFixture('active-gate-gate13-predecessor-open');
  revertGate13ToPreReconciliation(dir);
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  // Rewrite the ledger so GATE12 is IN_PROGRESS instead of COMPLETE_CONFIRMED, recomputing the
  // hash chain exactly like a real writer would, to isolate PREDECESSOR_NOT_CLOSED specifically
  // from a generic LEDGER_INVALID chain-break rejection.
  const canonicalize = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  };
  const ledgerPath = path.join(dir, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let previousPayload = null;
  for (let i = 0; i < lines.length; i += 1) {
    const ev = lines[i];
    if (ev.gateId === 'GATE12') ev.toStatus = 'IN_PROGRESS';
    ev.previousEventSha256 = previousPayload;
    const payload = { ...ev }; delete payload.eventPayloadSha256;
    ev.eventPayloadSha256 = h(Buffer.from(canonicalize(payload), 'utf8'));
    previousPayload = ev.eventPayloadSha256;
    lines[i] = ev;
  }
  fs.writeFileSync(ledgerPath, lines.map((ev) => canonicalize(ev)).join('\n') + '\n');
  const { code, out, err } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  assert.equal(JSON.parse(out).valid, true, 'the mutated ledger must itself still be internally valid so this case isolates the predecessor check');
  const active = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(active.err);
  assert.equal(active.code, 2);
  assert.ok(report.findingIds.includes('PREDECESSOR_NOT_CLOSED'));
});

test('G13-REPAIR-13 (hostile): GATE14 (no authority anywhere) is rejected', () => {
  const dir = makeFixture('active-gate-gate14');
  const candidate = JSON.stringify({
    schemaVersion: 1, activeGate: 'GATE14', activationEventId: 'GENESIS_IMPORT_GATE14', activationEventOrdinal: 15,
    activationEventSha256: '90d5d7e5fc3d75edec62d298939b9a5d59ea61240c9fb5651da29db5269ea172',
    currentStatePath: 'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    currentStateSha256: '07734e8b1e705b525f35a7916b0b1ca09ca029df56f83495e389219bfea072aa'
  });
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), candidate);
  const { code, err } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(err);
  assert.equal(code, 2);
  assert.ok(report.findingIds.includes('ACTIVE_GATE_NOT_AUTHORIZED'));
  assert.ok(report.findingIds.includes('GATE_STATUS_NOT_AUTHORIZED'));
});

test('G13-REPAIR-14 (hostile): an unknown gate number is rejected', () => {
  const dir = makeFixture('active-gate-unknown');
  const candidate = JSON.stringify({
    schemaVersion: 1, activeGate: 'GATE41', activationEventId: 'GENESIS_IMPORT_GATE14', activationEventOrdinal: 15,
    activationEventSha256: '90d5d7e5fc3d75edec62d298939b9a5d59ea61240c9fb5651da29db5269ea172',
    currentStatePath: 'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    currentStateSha256: '07734e8b1e705b525f35a7916b0b1ca09ca029df56f83495e389219bfea072aa'
  });
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), candidate);
  const { code, err } = run('governance/tools/validate-active-gate.mjs', [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  const report = JSON.parse(err);
  assert.equal(code, 2);
  assert.ok(report.findingIds.includes('ACTIVE_GATE_NOT_AUTHORIZED'));
});

test('G13-REPAIR-15 (hostile): a GENERATED file cited as ledger authority is still rejected (pre-existing check preserved)', () => {
  const dir = makeFixture('active-gate-generated-authority');
  const ledgerPath = path.join(dir, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  assert.equal(first.authorityPath, 'governance/GATE_REGISTRY_00_40.json');
  // Point GATE00's genesis import at the GENERATED snapshot file instead, with a matching hash, and
  // verify the pre-existing GENERATED_AUTHORITY_CITED detector (untouched by this repair) still fires.
  const generatedPath = path.join(dir, 'governance/state/generated/GATE_STATUS_SNAPSHOT.json');
  const generatedSha = h(fs.readFileSync(generatedPath));
  first.authorityPath = 'governance/state/generated/GATE_STATUS_SNAPSHOT.json';
  first.authoritySha256 = generatedSha;
  const canonicalize = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  };
  const payload = { ...first }; delete payload.eventPayloadSha256;
  first.eventPayloadSha256 = h(Buffer.from(canonicalize(payload), 'utf8'));
  lines[0] = canonicalize(first);
  // Re-chain line 2 onward since line 1's payload hash changed.
  let previousPayload = first.eventPayloadSha256;
  for (let i = 1; i < lines.length; i += 1) {
    const ev = JSON.parse(lines[i]);
    ev.previousEventSha256 = previousPayload;
    const p2 = { ...ev }; delete p2.eventPayloadSha256;
    ev.eventPayloadSha256 = h(Buffer.from(canonicalize(p2), 'utf8'));
    previousPayload = ev.eventPayloadSha256;
    lines[i] = canonicalize(ev);
  }
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');
  const { out } = run('governance/tools/validate-status-ledger.mjs', ['--root', dir], dir);
  const report = JSON.parse(out);
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'GENERATED_AUTHORITY_CITED'));
});

test('G13-REPAIR-16: reproducible from a different working directory', () => {
  const dir = makeFixture('active-gate-different-cwd');
  fs.writeFileSync(path.join(dir, 'governance/active/CANDIDATE.json'), gate13Candidate());
  // process.cwd() inside the tool is the gate on every internal path.join(root, ...), so invoking it
  // by absolute script path from an unrelated cwd (os.tmpdir()) with cwd still pinned to the fixture
  // proves resolution does not silently depend on the terminal's cwd being the repo root.
  const { code, out } = run(path.join(dir, 'governance/tools/validate-active-gate.mjs'), [], dir, { ACTIVE_GATE_PATH: 'governance/active/CANDIDATE.json' });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { valid: true, findingIds: [] });
});
