import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';

const constitutionIndex = process.argv.indexOf('--constitution');
const repoIndex = process.argv.indexOf('--repo');
const repositoryRoot = repoIndex >= 0 ? process.argv[repoIndex + 1] : process.cwd();
const constitutionFile = constitutionIndex >= 0 ? process.argv[constitutionIndex + 1] : path.join(repositoryRoot, 'governance/PROJECT_CONSTITUTION.json');
const governed = JSON.parse(fs.readFileSync(constitutionFile, 'utf8')).governedRepository;
const findings = [];
const git = (args) => cp.execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
if (git(['rev-parse', '--show-toplevel']).replace(/\\/g, '/') !== governed.gitRoot) findings.push('REPOSITORY_IDENTITY_MISMATCH');
if (repositoryRoot.replace(/\\/g, '/') !== governed.canonicalPath) findings.push('REPOSITORY_IDENTITY_MISMATCH');
if (git(['branch', '--show-current']) !== governed.branch) findings.push('REPOSITORY_IDENTITY_MISMATCH');
if (governed.headIsIdentity !== false) findings.push('HEAD_USED_AS_PERMANENT_REPOSITORY_IDENTITY');
for (const marker of governed.requiredProjectMarkers || []) if (!fs.existsSync(path.join(repositoryRoot, marker))) findings.push('REQUIRED_PROJECT_MARKER_MISSING:' + marker);
const report = { document: 'I1_REPOSITORY_IDENTITY_VALIDATION', blockingFindings: findings, blockingTotal: findings.length, verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS' };
console.log(JSON.stringify(report, null, 2));
process.exitCode = findings.length ? 2 : 0;
