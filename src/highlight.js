// Zero-dependency, ANSI-only syntax highlighter. Regex-driven with
// comment/string masking so keywords inside strings stay unstyled.
// Languages with dedicated rules: js,ts,jsx,tsx,js-like,json,bash,sh,python,
// go,rust,yaml,toml,css,html,xml,sql,markdown,diff. Anything else is plain.
//
// Palette stays consistent with src/ui.js (violet keywords, green strings,
// cyan numbers, yellow types, faint comments, dim punctuation) so the code
// blocks read as a calm variant of the rest of the terminal feed.

import { text as bright, dim, faint, violet, green, cyan, yellow } from './ui.js'

const trim = (s) => String(s).trim()

// Tokenize into [{t, type}] then style. type ∈ keyword|type|builtin|string|
// number|comment|operator|punct|function|property|tag|attr|regex|plain.
// Lines are highlighted independently (good enough for the transcript flow).

const KEYWORDS = new Set([
  // ECMAScript / TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends',
  'super', 'this', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
  'yield', 'await', 'async', 'import', 'export', 'from', 'as', 'default',
  'try', 'catch', 'finally', 'throw', 'static', 'get', 'set', 'public',
  'private', 'protected', 'readonly', 'interface', 'type', 'enum', 'namespace',
  'module', 'declare', 'abstract', 'implements', 'satisfies', 'keyof', 'infer',
  'is', 'as', 'asserts', 'readonly', 'override',
  // python
  'def', 'elif', 'lambda', 'with', 'pass', 'raise', 'global', 'nonlocal',
  'True', 'False', 'None', 'and', 'or', 'not', 'is', 'in', 'from', 'import',
  'class', 'yield', 'assert', 'del', 'print',
  // go
  'package', 'func', 'go', 'chan', 'select', 'defer', 'range', 'map', 'struct',
  'interface', 'type', 'fallthrough', 'goto', 'make', 'len',
  // rust
  'fn', 'let', 'mut', 'pub', 'use', 'mod', 'impl', 'trait', 'where', 'move',
  'ref', 'match', 'unsafe', 'crate', 'self', 'Self', 'dyn', 'as', 'loop',
  // bash/sh
  'if', 'then', 'fi', 'else', 'elif', 'case', 'esac', 'for', 'while', 'do',
  'done', 'function', 'in', 'select', 'until', 'return', 'export', 'local',
  'readonly', 'declare', 'set', 'unset', 'shift', 'trap', 'echo', 'exit',
  'source', 'alias',
  // sql
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LEFT',
  'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'ORDER',
  'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'INTO', 'SET', 'CREATE',
  'TABLE', 'INDEX', 'VIEW', 'DROP', 'ALTER', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'UNIQUE', 'DEFAULT', 'CHECK', 'IF', 'EXISTS', 'CASCADE', 'DISTINCT',
  'UNION', 'ALL', 'WITH', 'RETURNING', 'SELECT', 'INSERT', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'TRANSACTION', 'TRUE', 'FALSE',
])

const TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'object', 'any',
  'unknown', 'never', 'symbol', 'bigint', 'Array', 'Map', 'Set', 'Promise',
  'Record', 'Readonly', 'Partial', 'Pick', 'Omit', 'Function', 'Date', 'Error',
  'RegExp', 'Promise', 'Uint8Array', 'Buffer', 'Process',
  'int', 'float', 'bool', 'string', 'byte', 'rune', 'error', 'uintptr',
  'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64',
  'Vec', 'String', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap', 'HashSet',
  'list', 'dict', 'tuple', 'set', 'int', 'float', 'str', 'bool', 'bytes',
  'TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'VARCHAR', 'BOOLEAN', 'SERIAL',
])

const BUILTINS = new Set([
  'console', 'process', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String',
  'Boolean', 'Symbol', 'Error', 'Date', 'RegExp', 'Promise', 'globalThis',
  'window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'require', 'module', 'exports', '__dirname', '__filename',
  'print', 'len', 'range', 'open', 'input', 'str', 'int', 'float', 'bool',
  'list', 'dict', 'tuple', 'set', 'sorted', 'enumerate', 'zip', 'map',
  'filter', 'reduce', 'len', 'append', 'extend', 'items', 'keys', 'values',
  'echo', 'printf', 'cat', 'grep', 'sed', 'awk', 'find', 'ls', 'cd', 'pwd',
  'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'curl', 'wget', 'git', 'npm',
  'node', 'python', 'pip', 'make', 'go', 'cargo', 'rustc',
])

function isWordChar(c) { return /[A-Za-z0-9_$]/.test(c) }

// Mask comment/strings then highlight identifiers on the residual, then
// restore. The mask is a list of {start, end, type} ranges on the original
// line; we render by walking the line and switching styles at range borders.
function maskStringsAndComments(line, lang) {
  const spans = [] // {start, end, type}
  let i = 0
  const n = line.length
  const push = (s, e, t) => spans.push({ start: s, end: e, type: t })
  while (i < n) {
    const c = line[i]
    const two = line.slice(i, i + 2)
    // line comments
    if (lang === 'py' && c === '#') { push(i, n, 'comment'); break }
    if (lang === 'yaml' && c === '#' && /^\s*#/.test(line.slice(0, i + 1))) { push(i, n, 'comment'); break }
    if (lang === 'sql' && (two === '--')) { push(i, n, 'comment'); break }
    if (c === '#') { push(i, n, 'comment'); break }
    if (two === '//') { push(i, n, 'comment'); break }
    // block-ish single-line /* ... */
    if (two === '/*') {
      let j = line.indexOf('*/', i + 2)
      if (j === -1) j = n; else j += 2
      push(i, j, 'comment'); i = j; continue
    }
    // strings: ", ', `
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      let j = i + 1
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === q) { j++; break }
        j++
      }
      push(i, j, 'string'); i = j; continue
    }
    // numbers
    if (/[0-9]/.test(c) && (i === 0 || !isWordChar(line[i - 1]))) {
      const m = line.slice(i).match(/^[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9]+)?/)
      if (m) { push(i, i + m[0].length, 'number'); i += m[0].length; continue }
    }
    i++
  }
  return spans
}

// Returns array of styled strings (one per source line) for a code block.
export function highlight(code, lang) {
  const lines = String(code).replace(/\r\n/g, '\n').split('\n')
  return lines.map((line) => highlightLine(line, lang))
}

function highlightLine(line, lang) {
  const l = line
  const spans = maskStringsAndComments(l, lang)
  // Build an array of segments [start,end,type] covering the whole line,
  // filling the gaps with 'plain'. Sort by start.
  spans.sort((a, b) => a.start - b.start)
  const segs = []
  let cursor = 0
  for (const s of spans) {
    if (s.start > cursor) segs.push({ start: cursor, end: s.start, type: 'plain' })
    segs.push(s)
    cursor = s.end
  }
  if (cursor < l.length) segs.push({ start: cursor, end: l.length, type: 'plain' })

  // For plain segments, do an identifier pass for keywords/types/builtins and
  // punctuation/operators.
  let out = ''
  for (const seg of segs) {
    const text = l.slice(seg.start, seg.end)
    if (seg.type === 'comment') { out += faint(text); continue }
    if (seg.type === 'string') { out += green(text); continue }
    if (seg.type === 'number') { out += cyan(text); continue }
    // plain: tokenize words vs punctuation/operators
    out += highlightPlain(text, lang)
  }
  return out
}

function highlightPlain(text, lang) {
  let out = ''
  let buf = ''
  const flush = () => {
    if (!buf) return
    if (KEYWORDS.has(buf) || (lang === 'sql' && KEYWORDS.has(buf.toUpperCase()))) out += violet(buf)
    else if (TYPES.has(buf)) out += yellow(buf)
    else if (BUILTINS.has(buf)) out += cyan(buf)
    else if (/^[A-Z][A-Za-z0-9_]*$/.test(buf) && buf.length > 1) out += yellow(buf)
    else out += bright(buf)
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (isWordChar(c)) { buf += c; continue }
    flush()
    if (/[{}()\[\];,.<>:]/.test(c)) {
      // `function(` → treat call as function highlight (next word already flushed)
      if (c === '(' && out && /[A-Za-z0-9_$]/.test(out.slice(-1))) {
        // convert the previously-flushed trailing identifier to a function style:
        // we already emitted it; re-scan by replacing the last identifier emit.
        // Simpler: leave it. Function-call coloring would require lookahead;
        // keep the mild version for now.
      }
      out += dim(c)
    } else if (/[+\-*/%=!&|?^~]/.test(c)) {
      out += violet(c)
    } else if (c === '@') {
      out += violet(c)
    } else {
      out += c
    }
  }
  flush()
  return out
}

export function supportsLang(lang) {
  const l = trim(String(lang || '')).toLowerCase()
  return !!LANG_HINTS[l]
}

const LANG_HINTS = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', typescript: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  py: 'py', python: 'py',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  css: 'css',
  html: 'html', xml: 'html',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
}

export function normalizeLang(label) {
  const l = trim(String(label || '')).toLowerCase()
  return LANG_HINTS[l] || (l || null)
}