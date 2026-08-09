import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '../../../../');
const IMPLEMENTATION = 'governance/gates/GATE13/implementation';
const ROOT_FILES = {
  policy: `${IMPLEMENTATION}/ORACLE_AND_COVERAGE_POLICY.json`,
  oracles: `${IMPLEMENTATION}/ORACLE_REGISTRY.json`,
  coverage: `${IMPLEMENTATION}/COVERAGE_REQUIREMENTS_REGISTRY.json`,
  matrix: `${IMPLEMENTATION}/ORACLE_COVERAGE_MATRIX.json`,
  report: `${IMPLEMENTATION}/COVERAGE_REPORT.json`,
  evidence: `${IMPLEMENTATION}/REPLAY_AND_PROVENANCE_EVIDENCE.json`,
  contract: 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json',
  pointer: 'governance/gates/GATE13/contracts/CURRENT_CONTRACT.json',
  registry: 'governance/GATE_REGISTRY_00_40.json',
  mandate: 'governance/sources/GATE13_CANONICAL_MANDATE_AND_EXECUTION_AUTHORITY_R1.json'
};

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes('*') || value.includes('?')) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveUnderRoot(root, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}

function readJson(root, relativePath, findings, label) {
  const file = resolveUnderRoot(root, relativePath);
  if (!file || !fs.existsSync(file)) {
    findings.push({ detectorId: 'MISSING_CANONICAL_INPUT', severity: 'BLOCKING', source: relativePath, label, message: 'Required canonical input is absent or unsafe.' });
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    findings.push({ detectorId: 'INVALID_CANONICAL_INPUT', severity: 'BLOCKING', source: relativePath, label, message: error.message });
    return null;
  }
}

function readOracleSource(root, oracle, findings) {
  const file = resolveUnderRoot(root, oracle.path);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { status: 'MISSING', actualSha256: null, byteLength: null, parsed: null };
  }
  const bytes = fs.readFileSync(file);
  const actualSha256 = sha256(bytes);
  let parsed = null;
  try {
    if (oracle.sourceType === 'JSON') parsed = JSON.parse(bytes.toString('utf8'));
    if (oracle.sourceType === 'NDJSON') parsed = bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (oracle.sourceType === 'MARKDOWN') parsed = bytes.toString('utf8');
  } catch (error) {
    findings.push({ detectorId: 'ORACLE_PARSE_ERROR', severity: oracle.required ? 'BLOCKING' : 'INFO', oracleId: oracle.oracleId, source: oracle.path, message: error.message });
    return { status: 'INVALID', actualSha256, byteLength: bytes.length, parsed: null };
  }
  if (actualSha256 !== oracle.expectedSha256) return { status: oracle.authorityClass === 'GENERATED_NON_CANONICAL' ? 'GENERATED_NON_CANONICAL' : 'STALE', actualSha256, byteLength: bytes.length, parsed };
  return { status: oracle.authorityClass === 'GENERATED_NON_CANONICAL' ? 'GENERATED_NON_CANONICAL' : 'VALID', actualSha256, byteLength: bytes.length, parsed };
}

function duplicateIds(items, key, detectorId, findings) {
  const seen = new Set();
  for (const [index, item] of (items || []).entries()) {
    const id = item?.[key];
    if (seen.has(id)) findings.push({ detectorId, severity: 'BLOCKING', index, id, message: `${key} is duplicated.` });
    seen.add(id);
  }
}

function detectCycles(items, idKey, dependencyKey, findings) {
  const ids = new Set((items || []).map((item) => item?.[idKey]));
  const graph = new Map((items || []).map((item) => [item?.[idKey], item?.[dependencyKey] || []]));
  for (const [id, dependencies] of graph) for (const dependency of dependencies) if (!ids.has(dependency)) findings.push({ detectorId: 'ORPHAN_DEPENDENCY', severity: 'BLOCKING', id, dependency, message: 'Dependency points to an unknown item.' });
  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) { findings.push({ detectorId: 'DEPENDENCY_CYCLE', severity: 'BLOCKING', cycle: [...chain, id], message: 'Coverage dependency cycle detected.' }); return; }
    if (visited.has(id) || !graph.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id)) visit(dependency, [...chain, id]);
    visiting.delete(id); visited.add(id);
  }
  for (const id of graph.keys()) visit(id, []);
}

function validate({ root }) {
  const findings = [];
  const policy = readJson(root, ROOT_FILES.policy, findings, 'policy');
  const oracleDoc = readJson(root, ROOT_FILES.oracles, findings, 'oracle registry');
  const coverageDoc = readJson(root, ROOT_FILES.coverage, findings, 'coverage registry');
  const contract = readJson(root, ROOT_FILES.contract, findings, 'execution contract');
  const pointer = readJson(root, ROOT_FILES.pointer, findings, 'contract pointer');
  const registry = readJson(root, ROOT_FILES.registry, findings, 'strategic registry');
  const mandate = readJson(root, ROOT_FILES.mandate, findings, 'canonical mandate');
  const oracles = Array.isArray(oracleDoc?.oracles) ? oracleDoc.oracles : [];
  const coverageItems = Array.isArray(coverageDoc?.coverageItems) ? coverageDoc.coverageItems : [];
  const oracleById = new Map(oracles.map((oracle) => [oracle.oracleId, oracle]));
  const coverageById = new Map(coverageItems.map((item) => [item.coverageItemId, item]));
  duplicateIds(oracles, 'oracleId', 'DUPLICATE_ORACLE_ID', findings);
  duplicateIds(coverageItems, 'coverageItemId', 'DUPLICATE_COVERAGE_ITEM_ID', findings);
  if (oracleDoc?.gateId !== 'GATE13' || coverageDoc?.gateId !== 'GATE13' || policy?.gateId !== 'GATE13') findings.push({ detectorId: 'GATE_ID_MISMATCH', severity: 'BLOCKING', message: 'All GATE13 implementation registries must identify GATE13.' });
  if (oracleDoc?.policyId !== policy?.policyId || coverageDoc?.policyId !== policy?.policyId) findings.push({ detectorId: 'POLICY_BINDING_MISMATCH', severity: 'BLOCKING', message: 'Registries must bind to the declared policy.' });
  const statuses = [];
  const pathPins = new Map();
  for (const oracle of oracles) {
    if (!safeRelative(oracle?.path)) findings.push({ detectorId: 'UNSAFE_ORACLE_PATH', severity: 'BLOCKING', oracleId: oracle?.oracleId, path: oracle?.path, message: 'Oracle path is not a normalized repository-relative path.' });
    if (oracle?.required && oracle?.authorityClass === 'GENERATED_NON_CANONICAL') findings.push({ detectorId: 'GENERATED_AUTHORITY_REQUIRED', severity: 'BLOCKING', oracleId: oracle.oracleId, message: 'Generated material cannot satisfy a mandatory oracle.' });
    if (oracle?.required && oracle?.fallbackPolicy !== 'NONE') findings.push({ detectorId: 'SILENT_FALLBACK_POLICY', severity: 'BLOCKING', oracleId: oracle.oracleId, message: 'Mandatory oracle declares a fallback.' });
    if (oracle?.path) {
      const prior = pathPins.get(oracle.path);
      if (prior && (prior.expectedSha256 !== oracle.expectedSha256 || prior.authorityClass !== oracle.authorityClass)) findings.push({ detectorId: 'CONTRADICTORY_ORACLE_PATH', severity: 'BLOCKING', path: oracle.path, message: 'The same source path has divergent pins or authorities.' });
      pathPins.set(oracle.path, oracle);
    }
    const result = readOracleSource(root, oracle, findings);
    statuses.push({ oracleId: oracle.oracleId, path: oracle.path, required: oracle.required === true, authorityClass: oracle.authorityClass, expectedSha256: oracle.expectedSha256, actualSha256: result.actualSha256, byteLength: result.byteLength, status: result.status });
  }
  for (const oracle of oracles) for (const consumerId of oracle.consumerIds || []) if (!coverageById.has(consumerId)) findings.push({ detectorId: 'ORPHAN_CONSUMER_REFERENCE', severity: oracle.required ? 'BLOCKING' : 'INFO', oracleId: oracle.oracleId, consumerId, message: 'Oracle consumer is not defined in the coverage registry.' });
  detectCycles(coverageItems, 'coverageItemId', 'dependsOnCoverageItemIds', findings);
  for (const item of coverageItems) {
    if (item.mandatory && item.failClosed !== true) findings.push({ detectorId: 'MANDATORY_NOT_FAIL_CLOSED', severity: 'BLOCKING', coverageItemId: item.coverageItemId, message: 'Mandatory coverage item must be fail-closed.' });
    if (item.mandatory && item.applicability !== 'ALWAYS') findings.push({ detectorId: 'MANDATORY_APPLICABILITY_REDUCED', severity: 'BLOCKING', coverageItemId: item.coverageItemId, message: 'A mandatory coverage item cannot be removed from the denominator by changing applicability.' });
    for (const oracleId of item.requiredOracleIds || []) if (!oracleById.has(oracleId)) findings.push({ detectorId: 'ORPHAN_ORACLE_REFERENCE', severity: 'BLOCKING', coverageItemId: item.coverageItemId, oracleId, message: 'Coverage item points to an unknown oracle.' });
  }
  if (contract) {
    const expectedOutputs = new Set((contract.requiredOutputs || []).map((item) => item.path));
    const mandateOutputs = (mandate?.requiredOutputs || []).map((item) => item.path);
    for (const output of mandateOutputs) if (!expectedOutputs.has(output)) findings.push({ detectorId: 'MANDATE_OUTPUT_NOT_CONTRACTED', severity: 'BLOCKING', output, message: 'Canonical mandate output is absent from the execution contract.' });
    if (!contract.closureConditions?.some((condition) => String(condition).includes('mandatoryCoverage=100%'))) findings.push({ detectorId: 'MANDATORY_COVERAGE_CLAUSE_MISSING', severity: 'BLOCKING', message: 'The contract does not bind mandatoryCoverage=100%.' });
    if (pointer?.contractPath !== 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json') findings.push({ detectorId: 'CONTRACT_POINTER_NOT_R0001', severity: 'BLOCKING', message: 'R0001 is the pinned executable contract for this implementation run.' });
  }
  const statusById = new Map(statuses.map((status) => [status.oracleId, status]));
  const coverageResults = coverageItems.map((item) => {
    const dependencies = item.dependsOnCoverageItemIds || [];
    const dependencyFailures = dependencies.filter((id) => !coverageById.has(id));
    const oracleStatuses = (item.requiredOracleIds || []).map((id) => statusById.get(id) || { oracleId: id, status: 'UNRESOLVED' });
    const failedOracles = oracleStatuses.filter((status) => status.status !== 'VALID');
    const satisfied = item.applicability === 'ALWAYS' && dependencyFailures.length === 0 && failedOracles.length === 0;
    return { coverageItemId: item.coverageItemId, mandatory: item.mandatory === true, applicability: item.applicability, requiredOracleIds: item.requiredOracleIds || [], oracleStatuses, dependencyFailures, status: satisfied ? 'SATISFIED' : 'UNSATISFIED', reason: satisfied ? null : [...dependencyFailures.map((id) => `missing_dependency:${id}`), ...failedOracles.map((status) => `${status.oracleId}:${status.status}`)] };
  });
  const applicableMandatory = coverageResults.filter((item) => item.mandatory && item.applicability === 'ALWAYS');
  const satisfiedMandatory = applicableMandatory.filter((item) => item.status === 'SATISFIED');
  const mandatoryCoverage = applicableMandatory.length === 0 ? 0 : Number(((satisfiedMandatory.length / applicableMandatory.length) * 100).toFixed(6));
  const mandatoryOracleStatuses = statuses.filter((status) => status.required);
  const countStatus = (status) => mandatoryOracleStatuses.filter((item) => item.status === status).length;
  const counts = {
    totalApplicable: applicableMandatory.length,
    totalMandatory: applicableMandatory.length,
    satisfied: satisfiedMandatory.length,
    missingMandatory: countStatus('MISSING'),
    invalidMandatory: countStatus('INVALID'),
    staleMandatory: countStatus('STALE'),
    contradictoryMandatory: findings.filter((finding) => finding.detectorId === 'CONTRADICTORY_ORACLE_PATH').length,
    unresolvedMandatory: findings.filter((finding) => ['ORPHAN_ORACLE_REFERENCE','ORPHAN_CONSUMER_REFERENCE','ORPHAN_DEPENDENCY'].includes(finding.detectorId)).length,
    fallbackSilent: findings.filter((finding) => finding.detectorId === 'SILENT_FALLBACK_POLICY').length,
    dependencyCycles: findings.filter((finding) => finding.detectorId === 'DEPENDENCY_CYCLE').length
  };
  const blockingFindings = findings.filter((finding) => finding.severity === 'BLOCKING');
  const verdict = blockingFindings.length === 0 && mandatoryCoverage === 100 && counts.missingMandatory === 0 && counts.invalidMandatory === 0 && counts.staleMandatory === 0 && counts.contradictoryMandatory === 0 && counts.unresolvedMandatory === 0 && counts.fallbackSilent === 0 && counts.dependencyCycles === 0 ? 'GATE13_ORACLE_COVERAGE_PASS' : 'GATE13_BLOCKED';
  const oracleStatuses = statuses.sort((a, b) => a.oracleId.localeCompare(b.oracleId));
  const matrix = { schemaVersion: 1, gateId: 'GATE13', policyId: policy?.policyId || null, oracleStatuses, coverageResults, counts, mandatoryCoverage, verdict, findings: findings.sort((a, b) => `${a.detectorId}:${a.oracleId || a.coverageItemId || ''}`.localeCompare(`${b.detectorId}:${b.oracleId || b.coverageItemId || ''}`)) };
  const report = { schemaVersion: 1, gateId: 'GATE13', totalApplicable: counts.totalApplicable, totalMandatory: counts.totalMandatory, satisfied: counts.satisfied, missingMandatory: counts.missingMandatory, invalidMandatory: counts.invalidMandatory, staleMandatory: counts.staleMandatory, contradictoryMandatory: counts.contradictoryMandatory, unresolvedMandatory: counts.unresolvedMandatory, mandatoryCoverage, findings: matrix.findings, verdict };
  const replay = { schemaVersion: 1, gateId: 'GATE13', calculation: { oracleRegistry: ROOT_FILES.oracles, coverageRegistry: ROOT_FILES.coverage, policy: ROOT_FILES.policy, contract: ROOT_FILES.contract, strategicRegistry: ROOT_FILES.registry, canonicalObjectiveSha256: contract?.strategicRegistryReference?.canonicalObjectiveSha256 || null }, oracleStatuses, coverageResults, counts, mandatoryCoverage, verdict, sourceHashes: Object.fromEntries(oracleStatuses.map((status) => [status.path, status.actualSha256])) };
  return { matrix, report, replay };
}

function writeOutputs(root, result) {
  const dir = path.join(root, IMPLEMENTATION.replaceAll('/', path.sep));
  fs.mkdirSync(dir, { recursive: true });
  const matrixBytes = stableBytes(result.matrix);
  const reportBytes = stableBytes(result.report);
  const evidence = { ...result.replay, matrixSha256: sha256(matrixBytes), reportSha256: sha256(reportBytes) };
  fs.writeFileSync(path.join(dir, 'ORACLE_COVERAGE_MATRIX.json'), matrixBytes);
  fs.writeFileSync(path.join(dir, 'COVERAGE_REPORT.json'), reportBytes);
  fs.writeFileSync(path.join(dir, 'REPLAY_AND_PROVENANCE_EVIDENCE.json'), stableBytes(evidence));
}

const root = path.resolve(option('--root', defaultRoot));
const result = validate({ root });
if (process.argv.includes('--write')) writeOutputs(root, result);
process.stdout.write(`${JSON.stringify({ valid: result.report.verdict === 'GATE13_ORACLE_COVERAGE_PASS', verdict: result.report.verdict, counts: { totalApplicable: result.report.totalApplicable, totalMandatory: result.report.totalMandatory, satisfied: result.report.satisfied, missingMandatory: result.report.missingMandatory, invalidMandatory: result.report.invalidMandatory, staleMandatory: result.report.staleMandatory, contradictoryMandatory: result.report.contradictoryMandatory, unresolvedMandatory: result.report.unresolvedMandatory }, mandatoryCoverage: result.report.mandatoryCoverage, findingCount: result.report.findings.length }, null, 2)}\n`);
process.exitCode = result.report.verdict === 'GATE13_ORACLE_COVERAGE_PASS' ? 0 : 2;
