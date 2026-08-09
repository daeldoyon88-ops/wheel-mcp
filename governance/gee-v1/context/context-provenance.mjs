import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const AUTHORITY_CLASSES = Object.freeze([
  'CANONICAL',
  'CANONICAL_STATUS',
  'CANONICAL_OBJECTIVE',
  'CANONICAL_RULE',
  'CANONICAL_EVIDENCE',
  'EXECUTION_CONTRACT',
  'NON_AUTHORITATIVE'
]);

function assertAuthorityClass(authorityClass) {
  if (!AUTHORITY_CLASSES.includes(authorityClass)) throw new Error(`UNKNOWN_AUTHORITY_CLASS:${authorityClass}`);
}

export function sha256File(repoRoot, sourcePath) {
  const absolute = path.resolve(repoRoot, sourcePath);
  if (!absolute.startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new Error(`SOURCE_OUTSIDE_REPOSITORY:${sourcePath}`);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`MISSING_CANONICAL_SOURCE:${sourcePath}`);
  }
  return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

export function createProvenance({ sourcePath, sourceField = null, authorityClass, selectionReason, sourceSha256 }) {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('PROVENANCE_SOURCE_PATH_REQUIRED');
  if (typeof authorityClass !== 'string' || !authorityClass) throw new Error('PROVENANCE_AUTHORITY_CLASS_REQUIRED');
  if (typeof selectionReason !== 'string' || !selectionReason) throw new Error('PROVENANCE_SELECTION_REASON_REQUIRED');
  assertAuthorityClass(authorityClass);
  return {
    sourcePath: sourcePath.replaceAll('\\', '/'),
    ...(sourceField ? { sourceField } : {}),
    ...(sourceSha256 ? { sourceSha256 } : {}),
    authorityClass,
    selectionReason
  };
}

export function canonicalSourceRecords(repoRoot, sources) {
  const rows = (Array.isArray(sources) ? sources : []).map((source) => {
    if (!source || typeof source.path !== 'string') throw new Error('SOURCE_RECORD_INVALID');
    const sourcePath = source.path.replaceAll('\\', '/');
    if (sourcePath.includes('/generated/') || sourcePath.startsWith('generated/')) throw new Error(`GENERATED_SOURCE_NOT_AUTHORITY:${sourcePath}`);
    const row = {
      path: sourcePath,
      role: source.role || 'relevant canonical source',
      relevanceReason: source.relevanceReason || 'selected by project adapter',
      sha256: sha256File(repoRoot, sourcePath),
      authorityClass: source.authorityClass || 'CANONICAL'
    };
    assertAuthorityClass(row.authorityClass);
    return row;
  });
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.path)) throw new Error(`DUPLICATE_SOURCE:${row.path}`);
    seen.add(row.path);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
