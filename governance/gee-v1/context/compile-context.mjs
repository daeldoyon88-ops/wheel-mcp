import fs from 'node:fs';
import path from 'node:path';
import { canonicalSourceRecords, createProvenance, sha256File } from './context-provenance.mjs';

const VERSION = 'GEE_V1_CONTEXT_COMPILER_R2';
const NON_AUTHORITATIVE = 'DERIVED / NON_AUTHORITATIVE';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function bytes(value) { return Buffer.byteLength(value, 'utf8'); }

function ensureBudget(bundle, markdown, budget) {
  const jsonText = JSON.stringify(bundle, null, 2) + '\n';
  const limits = budget || {};
  const violations = [];
  if (Number.isInteger(limits.maxBytes) && bytes(jsonText) + bytes(markdown) > limits.maxBytes) violations.push('maxBytes');
  if (Number.isInteger(limits.maxCharacters) && jsonText.length + markdown.length > limits.maxCharacters) violations.push('maxCharacters');
  if (Number.isInteger(limits.maxFacts) && bundle.facts.length > limits.maxFacts) violations.push('maxFacts');
  if (Number.isInteger(limits.maxReferences) && bundle.reusableEvidenceReferences.length > limits.maxReferences) violations.push('maxReferences');
  if (violations.length) throw new Error(`CONTEXT_BUDGET_INSUFFICIENT:${violations.join(',')}`);
}

function provenanceForItem(repoRoot, sourceRows, item, fallbackPath, sourceField, authorityClass, selectionReason) {
  const sourcePath = item.sourcePath || fallbackPath;
  const sourceSha256 = sourceRows.find((source) => source.path === sourcePath)?.sha256 || sha256File(repoRoot, sourcePath);
  return createProvenance({ sourcePath, sourceField: item.sourceField || sourceField, sourceSha256, authorityClass: item.authorityClass || authorityClass, selectionReason: item.selectionReason || selectionReason });
}

function evidenceReferences(repoRoot, sourceRows, items) {
  return (items || []).map((raw) => {
    const item = typeof raw === 'string' ? { ref: raw, trusted: true } : raw;
    const ref = item.path || item.ref;
    if (typeof ref !== 'string' || !ref) throw new Error('EVIDENCE_REFERENCE_INVALID');
    if (item.verified === false) return { ref, reason: item.reason || 'evidence explicitly marked unverified; cannot affect execution', authorityStatus: 'NON_AUTHORITATIVE_UNVERIFIED', provenance: null };
    const isLocal = !ref.includes('://') && !ref.startsWith('external:');
    if (isLocal) {
      try {
        const sourceSha256 = sourceRows.find((source) => source.path === ref)?.sha256 || sha256File(repoRoot, ref);
        return { ref, reason: item.reason || 'grounded canonical evidence reference; body not embedded', authorityStatus: 'GROUNDED', provenance: createProvenance({ sourcePath: ref, sourceField: item.sourceField || 'evidence', sourceSha256, authorityClass: item.authorityClass || 'CANONICAL_EVIDENCE', selectionReason: item.selectionReason || 'trusted evidence reference is grounded by existence and stable hash' }) };
      } catch (error) {
        if (item.trusted !== false) throw new Error(`MISSING_TRUSTED_EVIDENCE:${ref}`);
      }
    } else if (item.trusted === true) {
      throw new Error(`UNGROUNDED_TRUSTED_EVIDENCE:${ref}`);
    }
    return { ref, reason: item.reason || 'unverified reference; cannot affect execution', authorityStatus: 'NON_AUTHORITATIVE_UNVERIFIED', provenance: null };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
}

export function renderContextMarkdown(bundle) {
  const lines = [
    `# ${bundle.identity.mission}`,
    '',
    `- Status: ${bundle.activeState.canonicalStatus}`,
    `- Work unit: ${bundle.identity.project}/${bundle.identity.workUnitType}/${bundle.identity.workUnitId}`,
    `- Compiler: ${bundle.identity.compilerVersion}`,
    `- Authority: ${NON_AUTHORITATIVE}`,
    '',
    '## Objective', '',
    bundle.objective.missionObjective,
    '',
    '## Applicable constraints', '',
    ...bundle.applicableConstraints.map((item) => `- ${item.ruleId}: ${item.statement}`),
    '',
    '## Active state and blockers', '',
    `- Canonical status: ${bundle.activeState.canonicalStatus}`,
    ...bundle.activeState.blockers.map((item) => `- BLOCKER: ${item.code}: ${item.detail}`),
    '',
    '## Relevant sources', '',
    ...bundle.relevantSources.map((source) => `- ${source.path} (${source.role}; sha256 ${source.sha256})`),
    '',
    '## Reusable evidence references', '',
    ...bundle.reusableEvidenceReferences.map((item) => `- ${item.ref}: ${item.reason}`),
    '',
    '## Prohibited actions', '',
    ...bundle.prohibitedActions.map((item) => `- ${item}`),
    '',
    '## Success conditions', '',
    ...bundle.successConditions.map((item) => `- ${item}`),
    '',
    `## Next action\n\n${bundle.nextAction}`,
    '',
    `> ${NON_AUTHORITATIVE}. Canonical sources remain authoritative.`
  ];
  return lines.join('\n');
}

export function compileContext({ repoRoot, adapter, workUnitId, mission, budget, sourceHead } = {}) {
  if (!adapter || typeof adapter.getWorkUnitView !== 'function') throw new Error('ADAPTER_REQUIRED');
  if (!workUnitId) throw new Error('WORK_UNIT_REQUIRED');
  const view = adapter.getWorkUnitView(workUnitId);
  if (!view || typeof view !== 'object') throw new Error('WORK_UNIT_VIEW_INVALID');
  const input = typeof adapter.getContextInput === 'function'
    ? adapter.getContextInput(workUnitId, mission)
    : { mission: mission || {}, sources: [], constraints: [], successConditions: [], prohibitedActions: [], nextAction: 'Inspect canonical work-unit state.' };
  if (Array.isArray(input.authorityConflicts) && input.authorityConflicts.length) throw new Error(`CONFLICTING_AUTHORITY:${input.authorityConflicts.join(',')}`);
  const sourceRows = canonicalSourceRecords(repoRoot, input.sources);
  if (!sourceRows.length) throw new Error('MISSING_CRITICAL_AUTHORITY:relevantSources');
  const status = view.state?.verified === true && view.state.identityBinding === 'BOUND'
    ? view.state.value : 'UNKNOWN';
  if (status === 'UNKNOWN') throw new Error('MISSING_CRITICAL_AUTHORITY:canonicalStatus');
  const stateSource = sourceRows.find((source) => source.path === view.state?.authority?.ref) || sourceRows[0];
  const objective = input.mission?.objective || view.objective;
  if (typeof objective !== 'string' || !objective.trim()) throw new Error('MISSING_CRITICAL_AUTHORITY:objective');
  const missionSourcePath = input.mission?.sourcePath || sourceRows[0].path;
  const missionSourceSha256 = sourceRows.find((source) => source.path === missionSourcePath)?.sha256 || sha256File(repoRoot, missionSourcePath);
  const facts = [
    { id: 'active-status', value: status, provenance: createProvenance({ sourcePath: stateSource.path, sourceField: 'status', sourceSha256: stateSource.sha256, authorityClass: 'CANONICAL_STATUS', selectionReason: 'status must come from verified bound state' }) },
    { id: 'mission-objective', value: objective, provenance: createProvenance({ sourcePath: missionSourcePath, sourceField: input.mission?.sourceField || 'objective', sourceSha256: missionSourceSha256, authorityClass: 'CANONICAL_OBJECTIVE', selectionReason: 'mission objective selected by adapter' }) }
  ];
  const contractSource = sourceRows.find((source) => /contracts\/EXECUTION_CONTRACT_R\d{4}\.json$/.test(source.path)) || stateSource;
  const prerequisites = (view.prerequisites || []).map((item) => ({ ...item, provenance: provenanceForItem(repoRoot, sourceRows, item, contractSource.path, 'prerequisites', 'EXECUTION_CONTRACT', 'prerequisite selected from the requested work-unit contract') }));
  const blockers = (view.defectsOpenKnowledge === 'UNKNOWN' ? [{ code: 'DEFECTS_UNKNOWN', detail: 'Open defects state is not proven.', sourcePath: stateSource.path, sourceField: 'defectsOpenKnowledge' }] : view.defectsOpenKnowledge === 'KNOWN_NONZERO' ? [{ code: 'ACTIVE_DEFECTS', detail: `Open defects count=${view.defectsOpenCount}`, sourcePath: stateSource.path, sourceField: 'defectsOpenCount' }] : []).concat(input.blockers || []).map((item) => ({ code: item.code, detail: item.detail, provenance: provenanceForItem(repoRoot, sourceRows, item, item.sourcePath || stateSource.path, item.sourceField || 'blocker', item.authorityClass || 'CANONICAL_STATUS', item.selectionReason || 'active blocker selected from canonical work-unit state') }));
  const bundle = stable({
    schemaVersion: 1,
    bundleKind: 'GEE_CONTEXT_BUNDLE',
    authorityDeclaration: NON_AUTHORITATIVE,
    identity: {
      project: view.projectId,
      workUnitType: view.workUnitType,
      workUnitId: view.workUnitId,
      mission: mission?.id || input.mission?.id || `${view.projectId}:${view.workUnitId}`,
      compilerVersion: VERSION,
      sourceHead: sourceHead || input.sourceHead || 'UNAVAILABLE_LOCAL_HEAD'
    },
    activeState: {
      canonicalStatus: status,
      prerequisites,
      blockers,
      closure: view.closure || null,
      provenance: facts[0].provenance
    },
    objective: {
      missionObjective: objective,
      expectedOutcome: input.mission?.expectedOutcome || 'Complete the declared mission and validate its success conditions.',
      provenance: facts[1].provenance
    },
    applicableConstraints: (input.constraints || []).map((item) => { const sourcePath = item.sourcePath || sourceRows[0].path; return { ...item, provenance: createProvenance({ sourcePath, sourceField: item.sourceField || null, sourceSha256: sourceRows.find((source) => source.path === sourcePath)?.sha256 || sha256File(repoRoot, sourcePath), authorityClass: item.authorityClass || 'CANONICAL_RULE', selectionReason: item.selectionReason || 'applicability selected by project adapter' }) }; }).sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    relevantSources: sourceRows,
    activeDefectsOrBlockers: blockers,
    reusableEvidenceReferences: evidenceReferences(repoRoot, sourceRows, input.evidenceReferences || view.evidence || []),
    prohibitedActions: [...(input.prohibitedActions || [])].sort(),
    successConditions: [...(input.successConditions || [])],
    nextAction: input.nextAction || 'No deterministic next action is available.',
    facts
  });
  const markdown = renderContextMarkdown(bundle);
  ensureBudget(bundle, markdown, budget);
  const sourceBytes = sourceRows.reduce((sum, item) => sum + fs.statSync(path.join(repoRoot, ...item.path.split('/'))).size, 0);
  const compiledJsonBytes = bytes(JSON.stringify(bundle));
  const compiledMarkdownBytes = bytes(markdown);
  return { json: bundle, markdown, metrics: { sourceBytes, compiledJsonBytes, compiledMarkdownBytes, reductionRatio: sourceBytes / Math.max(1, compiledJsonBytes + compiledMarkdownBytes), tokenMeasurement: 'NOT_AVAILABLE' } };
}

export { VERSION, NON_AUTHORITATIVE };
