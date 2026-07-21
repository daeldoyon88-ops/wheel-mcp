/**
 * Conservative static source-policy guard for the independent fixed-point oracle.
 * Analyzes helper source text only — never executes the inspected source.
 *
 * Allowlist for the oracle helper: empty (zero imports required).
 */

/** @typedef {{ reason: string, detail?: string }} IndependentOracleSourcePolicyViolation */

const FORBIDDEN_SUBSTRINGS = Object.freeze([
  'import(',
  'require(',
  'createRequire',
  'eval(',
  'new Function',
  'WebAssembly',
  'import.meta.resolve',
  'fs.readFile',
  'fs.readFileSync',
  'fs.promises.readFile',
  'file:',
]);

const FORBIDDEN_IDENTIFIERS = Object.freeze([
  'fixedPointFeatureMathL4V1',
  'divideRoundHalfEven',
  'fixedToCanonical',
  'powerOfTen',
  'availableFixedCell',
  'readFileSync',
  'createRequire',
  'WebAssembly',
]);

const STATIC_IMPORT_RE = /^\s*import\b/m;
// Re-export forms only: export { ... } from '...'; export * from '...';
const EXPORT_FROM_RE = /^\s*export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]/m;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;
const REQUIRE_RE = /\brequire\s*\(/;
const CREATE_REQUIRE_RE = /\bcreateRequire\b/;
const EVAL_RE = /\beval\s*\(/;
const FUNCTION_CTOR_RE = /(?:\bFunction\s*\(|\bnew\s+Function\b)/;
const IMPORT_META_RESOLVE_RE = /import\.meta\.resolve/;
const FILE_URL_SPECIFIER_RE = /['"]file:[^'"]+['"]/;
const RELATIVE_FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/m;

/**
 * @param {string} sourceText
 * @param {{ allowlist?: readonly string[] }} [options]
 * @returns {IndependentOracleSourcePolicyViolation[]}
 */
export function findIndependentOracleSourcePolicyViolations(sourceText, options = {}) {
  const allowlist = new Set(options.allowlist ?? []);
  if (typeof sourceText !== 'string') {
    return [{ reason: 'source_not_string' }];
  }
  /** @type {IndependentOracleSourcePolicyViolation[]} */
  const violations = [];

  for (const literal of FORBIDDEN_SUBSTRINGS) {
    if (sourceText.includes(literal)) {
      violations.push({ reason: 'forbidden_literal', detail: literal });
    }
  }
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    const re = new RegExp(`\\b${identifier}\\b`);
    if (re.test(sourceText)) {
      violations.push({ reason: 'forbidden_identifier', detail: identifier });
    }
  }
  // Bare Function( constructor call (not new Function, already covered).
  if (/\bFunction\s*\(/.test(sourceText)) {
    violations.push({ reason: 'Function_constructor', detail: 'Function(' });
  }
  if (DYNAMIC_IMPORT_RE.test(sourceText)) {
    violations.push({ reason: 'dynamic_import' });
  }
  if (REQUIRE_RE.test(sourceText)) {
    violations.push({ reason: 'require' });
  }
  if (CREATE_REQUIRE_RE.test(sourceText)) {
    violations.push({ reason: 'createRequire' });
  }
  if (EVAL_RE.test(sourceText)) {
    violations.push({ reason: 'eval' });
  }
  if (FUNCTION_CTOR_RE.test(sourceText)) {
    violations.push({ reason: 'Function_constructor' });
  }
  if (IMPORT_META_RESOLVE_RE.test(sourceText)) {
    violations.push({ reason: 'import_meta_resolve' });
  }
  if (FILE_URL_SPECIFIER_RE.test(sourceText)) {
    violations.push({ reason: 'file_url_specifier' });
  }
  if (EXPORT_FROM_RE.test(sourceText)) {
    violations.push({ reason: 'reexport_from' });
  }
  if (STATIC_IMPORT_RE.test(sourceText) || SIDE_EFFECT_IMPORT_RE.test(sourceText)) {
    const specifiers = new Set();
    for (const match of sourceText.matchAll(RELATIVE_FROM_RE)) specifiers.add(match[1]);
    for (const match of sourceText.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
      specifiers.add(match[1]);
    }
    if (specifiers.size === 0) {
      violations.push({ reason: 'static_import_not_allowlisted', detail: '<unparsed>' });
    } else {
      for (const specifier of specifiers) {
        if (!allowlist.has(specifier)) {
          violations.push({ reason: 'static_import_not_allowlisted', detail: specifier });
        }
      }
    }
  }
  // Concatenation / template construction hints toward production math module.
  if (/fixedPointFeatureMathL4V1/.test(sourceText)
      && (/[`+]/.test(sourceText) || /['"]\s*\+/.test(sourceText))) {
    violations.push({ reason: 'concatenated_or_template_specifier_hint' });
  }
  return violations;
}

/**
 * @param {string} sourceText
 * @param {{ allowlist?: readonly string[] }} [options]
 */
export function assertIndependentOracleSourcePolicy(sourceText, options = {}) {
  const violations = findIndependentOracleSourcePolicyViolations(sourceText, options);
  if (violations.length > 0) {
    const first = violations[0];
    const error = new Error(
      `independent oracle source policy violated: ${first.reason}`
        + (first.detail ? ` (${first.detail})` : ''),
    );
    error.name = 'IndependentOracleSourcePolicyError';
    error.violations = violations;
    throw error;
  }
}
