/**
 * Deterministic ESM module-specifier scanner for the lab coupling gates.
 *
 * A single lexical pass classifies every character as whitespace, comment,
 * string, template, regular expression, identifier, number or punctuator, then
 * a token pass extracts module specifiers. Only tokens can produce a
 * specifier, so identifiers named `from`, string contents, template contents
 * and comment prose can never be mistaken for an import.
 *
 * Recognised specifier forms:
 *   IMPORT_FROM         import x from 'm' / import {x} from "m" / import * as n from 'm'
 *   EXPORT_FROM         export {x} from 'm' / export * from 'm'
 *   IMPORT_BARE         import 'm'
 *   IMPORT_DYNAMIC      import('m') / await import("m") / import(`m`) without substitution
 *   TYPE_ONLY_COMMENT   JSDoc type reference `import('m')` inside a block comment
 *
 * `import.meta` produces no specifier. A dynamic import whose argument is not
 * a literal is not resolvable by static analysis: it yields the fail-closed
 * diagnostic DYNAMIC_IMPORT_SPECIFIER_NOT_LITERAL instead of being ignored.
 *
 * Specifier text is returned with backslash escape sequences left raw; lab
 * specifiers are plain relative paths or `node:` builtins, so no unescaping
 * step is required and none is performed.
 */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const NUMBER_PART = /[0-9A-Za-z_.]/;

/** Punctuators after which a `/` opens a regular expression, never a division. */
const REGEX_ALLOWED_AFTER_PUNCT = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', '~', '^',
]);

/** Keywords after which a `/` opens a regular expression. */
const REGEX_ALLOWED_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case',
  'yield', 'await',
]);

/**
 * JSDoc type reference form only. The bounded character class forbids quotes
 * and line breaks so the match can never run away across a comment.
 */
const JSDOC_TYPE_IMPORT = /\bimport\s*\(\s*(['"])([^'"\r\n]*)\1\s*\)/g;

/** Maximum tokens walked back to attribute a `from` clause to import/export. */
const FROM_CLAUSE_LOOKBACK = 256;

/**
 * Read a template-literal chunk starting at `start`, stopping at the closing
 * backtick or at the `${` that opens a substitution.
 * @param {string} source @param {number} start
 */
function readTemplateChunk(source, start) {
  let index = start;
  let raw = '';
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      raw += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '`') return { end: index + 1, raw, substitution: false };
    if (character === '$' && source[index + 1] === '{') return { end: index + 2, raw, substitution: true };
    raw += character;
    index += 1;
  }
  return { end: index, raw, substitution: false };
}

/** @param {string} source @param {number} index */
function lineAt(source, index) {
  let line = 1;
  const bound = Math.min(index, source.length);
  for (let cursor = 0; cursor < bound; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

/**
 * Attribute a `from` clause to its statement head.
 * @param {{t: string, v?: string}[]} tokens @param {number} fromIndex
 */
function fromClauseKind(tokens, fromIndex) {
  const stop = Math.max(0, fromIndex - FROM_CLAUSE_LOOKBACK);
  for (let cursor = fromIndex - 1; cursor >= stop; cursor -= 1) {
    const token = tokens[cursor];
    if (token.t === 'punct' && token.v === ';') break;
    if (token.t !== 'id') continue;
    if (token.v === 'import') return 'IMPORT_FROM';
    if (token.v === 'export') return 'EXPORT_FROM';
  }
  return 'FROM_CLAUSE';
}

/**
 * @param {string} source
 * @returns {{specifiers: {specifier: string, kind: string, index: number, line: number}[],
 *            diagnostics: {code: string, index: number, line: number}[]}}
 */
export function scanModuleSpecifiers(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');

  /** @type {{t: string, v?: string|null, index: number}[]} */
  const tokens = [];
  /** @type {{specifier: string, kind: string, index: number, line: number}[]} */
  const specifiers = [];
  /** @type {{code: string, index: number, line: number}[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const braceStack = [];
  const length = source.length;
  let index = 0;

  while (index < length) {
    const character = source[index];

    if (character === ' ' || character === '\t' || character === '\r' || character === '\n'
        || character === '\f' || character === '\v' || character === ' ' || character === '﻿') {
      index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? length : end + 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? length : close + 2;
      const body = source.slice(index, end);
      JSDOC_TYPE_IMPORT.lastIndex = 0;
      let match;
      while ((match = JSDOC_TYPE_IMPORT.exec(body)) !== null) {
        const at = index + match.index;
        specifiers.push({ specifier: match[2], kind: 'TYPE_ONLY_COMMENT', index: at, line: lineAt(source, at) });
      }
      index = end;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      let cursor = index + 1;
      let value = '';
      while (cursor < length) {
        const inner = source[cursor];
        if (inner === '\\') {
          value += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (inner === quote) {
          cursor += 1;
          break;
        }
        if (inner === '\n') break;
        value += inner;
        cursor += 1;
      }
      tokens.push({ t: 'str', v: value, index });
      index = cursor;
      continue;
    }

    if (character === '`') {
      const chunk = readTemplateChunk(source, index + 1);
      if (chunk.substitution) {
        braceStack.push('T');
      } else {
        tokens.push({ t: 'tpl', v: chunk.raw, index });
      }
      index = chunk.end;
      continue;
    }

    if (character === '}' && braceStack[braceStack.length - 1] === 'T') {
      braceStack.pop();
      const chunk = readTemplateChunk(source, index + 1);
      if (chunk.substitution) {
        braceStack.push('T');
      } else {
        tokens.push({ t: 'tpl', v: null, index });
      }
      index = chunk.end;
      continue;
    }

    if (character === '/') {
      const previous = tokens[tokens.length - 1];
      const isRegex = previous === undefined
        || (previous.t === 'punct' && REGEX_ALLOWED_AFTER_PUNCT.has(/** @type {string} */ (previous.v)))
        || (previous.t === 'id' && REGEX_ALLOWED_AFTER_KEYWORD.has(/** @type {string} */ (previous.v)));
      if (!isRegex) {
        tokens.push({ t: 'punct', v: '/', index });
        index += 1;
        continue;
      }
      let cursor = index + 1;
      let inClass = false;
      while (cursor < length) {
        const inner = source[cursor];
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '\n') break;
        if (inClass) {
          if (inner === ']') inClass = false;
        } else if (inner === '[') {
          inClass = true;
        } else if (inner === '/') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      while (cursor < length && IDENT_PART.test(source[cursor])) cursor += 1;
      tokens.push({ t: 'regex', index });
      index = cursor;
      continue;
    }

    if (IDENT_START.test(character)) {
      let cursor = index + 1;
      while (cursor < length && IDENT_PART.test(source[cursor])) cursor += 1;
      tokens.push({ t: 'id', v: source.slice(index, cursor), index });
      index = cursor;
      continue;
    }

    if (DIGIT.test(character)) {
      let cursor = index + 1;
      while (cursor < length && NUMBER_PART.test(source[cursor])) cursor += 1;
      tokens.push({ t: 'num', index });
      index = cursor;
      continue;
    }

    if (character === '{') braceStack.push('B');
    else if (character === '}') braceStack.pop();
    tokens.push({ t: 'punct', v: character, index });
    index += 1;
  }

  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.t !== 'id') continue;

    if (token.v === 'import') {
      const previous = tokens[cursor - 1];
      if (previous && previous.t === 'punct' && previous.v === '.') continue;
      const next = tokens[cursor + 1];
      if (!next) continue;
      if (next.t === 'str') {
        specifiers.push({
          specifier: /** @type {string} */ (next.v),
          kind: 'IMPORT_BARE',
          index: next.index,
          line: lineAt(source, next.index),
        });
        continue;
      }
      if (next.t === 'punct' && next.v === '(') {
        const argument = tokens[cursor + 2];
        if (argument && (argument.t === 'str' || (argument.t === 'tpl' && typeof argument.v === 'string'))) {
          specifiers.push({
            specifier: /** @type {string} */ (argument.v),
            kind: 'IMPORT_DYNAMIC',
            index: argument.index,
            line: lineAt(source, argument.index),
          });
        } else {
          diagnostics.push({
            code: 'DYNAMIC_IMPORT_SPECIFIER_NOT_LITERAL',
            index: next.index,
            line: lineAt(source, next.index),
          });
        }
      }
      continue;
    }

    if (token.v === 'from') {
      const next = tokens[cursor + 1];
      if (next && next.t === 'str') {
        specifiers.push({
          specifier: /** @type {string} */ (next.v),
          kind: fromClauseKind(tokens, cursor),
          index: next.index,
          line: lineAt(source, next.index),
        });
      }
    }
  }

  return { specifiers, diagnostics };
}
