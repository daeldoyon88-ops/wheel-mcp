#!/usr/bin/env node
/**
 * Generates the human-readable projection of the master reuse matrix.
 *
 * The output is a PROJECTION and never an authority: it carries canonical=false
 * in its header, exactly like the other generated governance documents, and
 * GENERATED_FILES_NON_CANONICAL forbids citing it as proof of anything.
 *
 * --check recomputes the bytes and reports GENERATED_FILE_DRIFT instead of
 * writing, so a stale projection can never silently diverge from its source.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const option = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const read = (relative) => fs.readFileSync(path.resolve(root, ...relative.split('/')), 'utf8').replace(/^﻿/, '');
const readJson = (relative) => JSON.parse(read(relative));
const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const MATRIX = 'governance/master-matrix/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.json';
const GEE = 'governance/master-matrix/GEE_LIVE_USAGE_MATRIX_V1.json';
const GATES = 'governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json';
const GAPS = 'governance/master-matrix/MASTER_GAP_REGISTER_V1.json';
const BASELINE = 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json';
const OUTPUT = 'governance/generated/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.md';

const matrix = readJson(MATRIX);
const gee = readJson(GEE);
const gates = readJson(GATES);
const gaps = readJson(GAPS);
const baseline = readJson(BASELINE);

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const list = (values, limit = 2) => {
  if (!Array.isArray(values) || values.length === 0) return '—';
  const shown = values.slice(0, limit).map(cell).join('<br>');
  return values.length > limit ? `${shown}<br>…+${values.length - limit}` : shown;
};

const lines = [];
lines.push('<!-- canonical=false -->');
lines.push('<!-- generatedBy=governance/tools/generate-master-matrix-docs.mjs -->');
lines.push(`<!-- generatedFrom=${MATRIX} -->`);
lines.push(`<!-- sourceDigest=${sha256(read(MATRIX))} -->`);
lines.push('');
lines.push('# Wheel master canonicalization and reuse matrix — V1');
lines.push('');
lines.push('Non-canonique : vue générée. L\'autorité est le JSON source.');
lines.push('');
lines.push(`- Base HEAD: \`${matrix.baseHead}\``);
lines.push(`- Ledger events: ${matrix.ledgerEventCount}`);
lines.push(`- Capabilities inventoried: ${matrix.capabilityCount}`);
lines.push(`- Genuine gaps: ${matrix.genuineGapCount}`);
lines.push('');
lines.push(matrix.statement);
lines.push('');

lines.push('## Status counts');
lines.push('');
lines.push('| Status | Count |');
lines.push('| --- | --- |');
for (const [status, count] of Object.entries(matrix.statusCounts)) lines.push(`| ${status} | ${count} |`);
lines.push('');

lines.push('## Capabilities');
lines.push('');
lines.push('| id | domain | capability | status | live consumer | required action | pri |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const row of matrix.capabilities) {
  lines.push(`| ${row.id} | ${cell(row.domain)} | ${cell(row.capability)} | ${row.canonicalStatus} | ${list(row.liveConsumerPaths, 1)} | ${cell(row.requiredAction)} | ${row.priority} |`);
}
lines.push('');

lines.push('## GEE V1 live usage');
lines.push('');
lines.push('| layer | name | gap status | live proof |');
lines.push('| --- | --- | --- | --- |');
for (const layer of gee.layers) {
  lines.push(`| ${layer.layer} | ${cell(layer.name)} | ${layer.gapStatus} | ${cell(layer.liveProof)} |`);
}
lines.push('');

lines.push('## Source-of-truth graph');
lines.push('');
lines.push('| domain | authority | resolver |');
lines.push('| --- | --- | --- |');
for (const domain of matrix.sourceOfTruthGraph.domains) {
  lines.push(`| ${cell(domain.domain)} | ${cell(domain.authority)} | ${cell(domain.resolver)} |`);
}
lines.push('');
lines.push(`Findings: ${Object.entries(matrix.sourceOfTruthGraph.findings).map(([key, value]) => `${key}=${value}`).join(', ')}`);
lines.push('');

lines.push('## GATE15–GATE40 pre-execution capability');
lines.push('');
lines.push(`Ready fast path now: ${gates.summary.readyFastPathCount} · mandate canonical: ${gates.summary.mandateCanonicalCount}/${gates.gateCount} · pre-execution gaps: ${gates.summary.preexecutionGapCount} · systemic gaps: ${gates.summary.systemicGapCount}`);
lines.push('');
lines.push('| gate | name | mandate canonical | contract derivable | dependencies | closed now | known blocking gap |');
lines.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const gate of gates.gates) {
  lines.push(`| ${gate.gateId} | ${cell(gate.officialName)} | ${gate.mandateCanonical} | ${gate.contractDerivable} | ${cell(gate.dependencies.join(', '))} | ${gate.dependenciesClosedNow} | ${gate.knownBlockingGap} |`);
}
lines.push('');

lines.push('## Regression baseline');
lines.push('');
lines.push(`Failure identities at this HEAD: ${baseline.failureIdentityCount} · rule: ${baseline.comparisonRule}`);
lines.push('');
lines.push('| root cause class | count |');
lines.push('| --- | --- |');
for (const [name, count] of Object.entries(baseline.rootCauseCounts)) lines.push(`| ${name} | ${count} |`);
lines.push('');

lines.push('## Open gap register');
lines.push('');
lines.push(`P0 open: ${gaps.openP0Count} · P1 open: ${gaps.openP1Count} · P2 open: ${gaps.openP2Count}`);
lines.push('');
lines.push('| id | severity | status | title |');
lines.push('| --- | --- | --- | --- |');
for (const finding of gaps.findings) {
  lines.push(`| ${finding.id} | ${finding.severity} | ${finding.status} | ${cell(finding.title)} |`);
}
lines.push('');

lines.push('## Standard Gate golden path');
lines.push('');
for (const key of ['mission1', 'mission2', 'mission3']) {
  const mission = matrix.standardGateGoldenPath[key];
  lines.push(`### ${mission.name}`);
  lines.push('');
  lines.push(`Reachable with existing machinery: **${mission.reachable}**`);
  lines.push('');
  lines.push('| step | primitive | required authority | ledger transition |');
  lines.push('| --- | --- | --- | --- |');
  for (const transition of mission.transitions) {
    lines.push(`| ${cell(transition.step)} | ${cell(transition.primitive)} | ${cell(transition.requiredAuthority)} | ${cell(transition.ledgerTransition)} |`);
  }
  lines.push('');
}
lines.push(`New generic mechanism required: ${matrix.standardGateGoldenPath.newGenericMechanismRequired}`);
lines.push('');

const content = lines.join('\n');
const outputPath = path.resolve(root, ...OUTPUT.split('/'));
const check = process.argv.includes('--check');
const findings = [];
if (check) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== content) findings.push({ code: 'GENERATED_FILE_DRIFT', file: OUTPUT });
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, outputPath);
}
const report = {
  document: 'MASTER_MATRIX_GENERATED_DOCUMENT_VALIDATION',
  check,
  outputPath: OUTPUT,
  blockingFindings: findings,
  blockingTotal: findings.length,
  verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS'
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = findings.length ? 2 : 0;
