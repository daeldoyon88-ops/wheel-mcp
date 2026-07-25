import test from 'node:test';
import assert from 'node:assert/strict';
import { scanModuleSpecifiers } from './moduleSpecifierScan.mjs';

/**
 * Detector-level gate for the lab coupling scan (CPL cases).
 *
 * Every snippet below is a JavaScript source fragment supplied as data, never
 * evaluated. POSITIVE cases must yield the forbidden specifier, NEGATIVE cases
 * must yield nothing, BOUNDARY cases pin the exact policy at the edges.
 */

const FORBIDDEN = 'forbidden-pkg';

const ALLOWED_BUILTINS = new Set([
  'node:fs', 'node:path', 'node:crypto', 'node:url', 'node:os', 'node:util',
  'node:test', 'node:assert', 'node:assert/strict',
]);

/** The exact admission predicate enforced by the lab coupling gate. */
function gateVerdict(specifier) {
  if (specifier.startsWith('node:')) return ALLOWED_BUILTINS.has(specifier) ? 'ACCEPT' : 'REJECT';
  return specifier.startsWith('./') || specifier.startsWith('../') ? 'ACCEPT' : 'REJECT';
}

/**
 * @type {{id: string, category: 'POSITIVE'|'NEGATIVE'|'BOUNDARY', source: string,
 *         expected: {specifier: string, kind: string, verdict: string}[],
 *         diagnostics?: string[]}[]}
 */
const CASES = [
  {
    id: 'CPL-P01',
    category: 'POSITIVE',
    source: `import def from '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P02',
    category: 'POSITIVE',
    source: `import { alpha, beta } from "${FORBIDDEN}";\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P03',
    category: 'POSITIVE',
    source: `import '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_BARE', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P04',
    category: 'POSITIVE',
    source: `export { alpha } from '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'EXPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P05',
    category: 'POSITIVE',
    source: `export * from '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'EXPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P06',
    category: 'POSITIVE',
    source: `const pending = import('${FORBIDDEN}');\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_DYNAMIC', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P07',
    category: 'POSITIVE',
    source: `const loaded = await import("${FORBIDDEN}");\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_DYNAMIC', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-P08',
    category: 'POSITIVE',
    source: `import {\n  alpha,\n  beta,\n}\n  from\n  '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },

  {
    id: 'CPL-N01',
    category: 'NEGATIVE',
    source: 'const from = computeValue();\n',
    expected: [],
  },
  {
    id: 'CPL-N02',
    category: 'NEGATIVE',
    source: 'export function monthsBetweenMonthKeys(from, to) {\n'
      + "  assertMonthKey(from, 'from');\n"
      + "  assertMonthKey(to, 'to');\n"
      + '  return 0;\n}\n',
    expected: [],
  },
  {
    id: 'CPL-N03',
    category: 'NEGATIVE',
    source: `const text = "from '${FORBIDDEN}'";\n`,
    expected: [],
  },
  {
    id: 'CPL-N04',
    category: 'NEGATIVE',
    source: `const text = 'import("${FORBIDDEN}")';\n`,
    expected: [],
  },
  {
    id: 'CPL-N05',
    category: 'NEGATIVE',
    source: `// import def from '${FORBIDDEN}';\nconst value = 1;\n`,
    expected: [],
  },
  {
    id: 'CPL-N06',
    category: 'NEGATIVE',
    source: `/* import def from '${FORBIDDEN}';\n   export * from '${FORBIDDEN}'; */\nconst value = 1;\n`,
    expected: [],
  },
  {
    id: 'CPL-N07',
    category: 'NEGATIVE',
    source: 'const range = { from: startKey, to: endKey };\n',
    expected: [],
  },
  {
    id: 'CPL-N08',
    category: 'NEGATIVE',
    source: 'function clampMonths(from, to) {\n  return to - from;\n}\n',
    expected: [],
  },
  {
    id: 'CPL-N09',
    category: 'NEGATIVE',
    source: 'const alpha = 1;\nexport { alpha };\nexport const beta = 2;\nexport default alpha;\n',
    expected: [],
  },
  {
    id: 'CPL-N10',
    category: 'NEGATIVE',
    source: "import { readFileSync } from 'node:fs';\n",
    expected: [{ specifier: 'node:fs', kind: 'IMPORT_FROM', verdict: 'ACCEPT' }],
  },
  {
    id: 'CPL-N11',
    category: 'NEGATIVE',
    source: "import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';\n",
    expected: [{ specifier: '../canonical/canonicalJsonV1.mjs', kind: 'IMPORT_FROM', verdict: 'ACCEPT' }],
  },

  {
    id: 'CPL-B01',
    category: 'BOUNDARY',
    source: `import\t  def \t from \t '${FORBIDDEN}'  ;\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-B02',
    category: 'BOUNDARY',
    source: `import def from "${FORBIDDEN}";\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-B03',
    category: 'BOUNDARY',
    source: `import\n  def,\n  {\n    alpha as renamed,\n  }\nfrom\n"${FORBIDDEN}";\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-B04',
    category: 'BOUNDARY',
    source: `export {\n  alpha,\n  beta as gamma,\n}\nfrom\n'${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'EXPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-B05',
    category: 'BOUNDARY',
    source: `const name = '${FORBIDDEN}';\nconst loaded = await import(name);\n`,
    expected: [],
    diagnostics: ['DYNAMIC_IMPORT_SPECIFIER_NOT_LITERAL'],
  },
  {
    id: 'CPL-B06',
    category: 'BOUNDARY',
    source: `import /* a */ def /* b */ from /* c */ '${FORBIDDEN}';\n`,
    expected: [{ specifier: FORBIDDEN, kind: 'IMPORT_FROM', verdict: 'REJECT' }],
  },
  {
    id: 'CPL-B07',
    category: 'BOUNDARY',
    source: "/** @param {import('../contracts/dailyBarV1.mjs').DailyBarV1[]} bars */\nfunction f(bars) { return bars; }\n",
    expected: [{
      specifier: '../contracts/dailyBarV1.mjs',
      kind: 'TYPE_ONLY_COMMENT',
      verdict: 'ACCEPT',
    }],
  },
  {
    id: 'CPL-B08',
    category: 'BOUNDARY',
    source: 'const loaded = await import(`./sibling.mjs`);\n',
    expected: [{ specifier: './sibling.mjs', kind: 'IMPORT_DYNAMIC', verdict: 'ACCEPT' }],
  },
  {
    id: 'CPL-B09',
    category: 'BOUNDARY',
    source: 'const loaded = await import(`./${name}.mjs`);\n',
    expected: [],
    diagnostics: ['DYNAMIC_IMPORT_SPECIFIER_NOT_LITERAL'],
  },
];

test('CPL detector cases produce the exact expected specifiers and verdicts', () => {
  for (const scenario of CASES) {
    const { specifiers, diagnostics } = scanModuleSpecifiers(scenario.source);
    assert.deepEqual(
      specifiers.map((entry) => ({
        specifier: entry.specifier,
        kind: entry.kind,
        verdict: gateVerdict(entry.specifier),
      })),
      scenario.expected,
      `${scenario.id}: specifier extraction diverges`,
    );
    assert.deepEqual(
      diagnostics.map((entry) => entry.code),
      scenario.diagnostics ?? [],
      `${scenario.id}: diagnostics diverge`,
    );
  }
});

test('CPL case table is complete, unique and balanced', () => {
  const ids = CASES.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length, 'CPL case identifiers must be unique');
  const byCategory = new Map();
  for (const scenario of CASES) {
    byCategory.set(scenario.category, (byCategory.get(scenario.category) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...byCategory].sort()), {
    BOUNDARY: 9,
    NEGATIVE: 11,
    POSITIVE: 8,
  });
  assert.equal(CASES.length, 28);
  for (const scenario of CASES) {
    assert.match(scenario.id, /^CPL-[PNB]\d{2}$/, `${scenario.id}: malformed identifier`);
    assert.equal(typeof scenario.source, 'string');
  }
});

test('every POSITIVE case is rejected and every detected NEGATIVE case is accepted', () => {
  for (const scenario of CASES.filter((entry) => entry.category === 'POSITIVE')) {
    assert.ok(scenario.expected.length > 0, `${scenario.id}: a positive case must detect a specifier`);
    for (const entry of scenario.expected) {
      assert.equal(entry.verdict, 'REJECT', `${scenario.id}: forbidden specifier must be rejected`);
    }
  }
  for (const scenario of CASES.filter((entry) => entry.category === 'NEGATIVE')) {
    for (const entry of scenario.expected) {
      assert.equal(entry.verdict, 'ACCEPT', `${scenario.id}: a negative case must never reject`);
    }
  }
});

test('import.meta never yields a module specifier', () => {
  const source = "const root = dirname(fileURLToPath(import.meta.url));\n"
    + "if (process.argv[1] && import.meta.url === href) { run(); }\n";
  assert.deepEqual(scanModuleSpecifiers(source), { specifiers: [], diagnostics: [] });
});

test('a regular expression containing quotes never desynchronises the scan', () => {
  const source = "const importRe = /(?:import\\s[^'\"]*?|from|import\\()\\s*['\"]([^'\"]+)['\"]/g;\n"
    + "import { after } from './after.mjs';\n";
  const { specifiers, diagnostics } = scanModuleSpecifiers(source);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(specifiers.map((entry) => entry.specifier), ['./after.mjs']);
});

test('division is not mistaken for a regular expression', () => {
  const source = 'const half = total / 2;\nconst ratio = (a + b) / (c - d);\n'
    + "import { after } from './after.mjs';\n";
  assert.deepEqual(
    scanModuleSpecifiers(source).specifiers.map((entry) => entry.specifier),
    ['./after.mjs'],
  );
});

test('template literals and their substitutions never leak a specifier', () => {
  const source = 'const label = `import def from \'hidden-pkg\'`;\n'
    + 'const nested = `${`inner ${"from \'deep-pkg\'"} tail`}`;\n'
    + "import { after } from './after.mjs';\n";
  const { specifiers, diagnostics } = scanModuleSpecifiers(source);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(specifiers.map((entry) => entry.specifier), ['./after.mjs']);
});

test('an unterminated block comment cannot swallow a later real import', () => {
  const source = `/* dangling\nimport def from '${FORBIDDEN}';\n`;
  assert.deepEqual(scanModuleSpecifiers(source), { specifiers: [], diagnostics: [] });
});

test('the scanner refuses non-string input', () => {
  assert.throws(() => scanModuleSpecifiers(null), TypeError);
  assert.throws(() => scanModuleSpecifiers(Buffer.from('import x from "m";')), TypeError);
});
