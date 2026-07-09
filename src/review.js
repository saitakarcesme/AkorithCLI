// Interactive diff browser for `akorith review --browser` (and a future
// /review panel). Parses a unified git diff into per-file hunks and renders
// a file list with the active file's diff inline. Scrollback-first: the
// active view is re-rendered in place (clear + reprint) on navigation.
//
// Keys: ↑/↓ move file · enter/space/→ expand · ←/backspace collapse ·
// n/p next/prev file · / filter · c clear filter · r review current file ·
// a expand-all · A collapse-all · q/esc exit.
//
// The parser is small and tolerant: it splits on `diff --git` headers and
// groups hunks under each file. Binary / renames are recorded as a single
// summary line with no body.

export function parseDiff(patch) {
  const lines = String(patch || '').split('\n')
  const files = []
  let cur = null
  let hunk = null
  const pushFile = (header) => {
    if (cur) files.push(cur)
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/)
    cur = m
      ? { path: m[2], oldPath: m[1], hunks: [], adds: 0, dels: 0, binary: false, summary: '', raw: [header] }
      : null
  }
  for (const line of lines) {
    if (/^diff --git /.test(line)) { pushFile(line); hunk = null; continue }
    if (!cur) continue
    cur.raw.push(line)
    if (/^new file mode/.test(line)) { cur.summary = 'new file'; continue }
    if (/^deleted file mode/.test(line)) { cur.summary = 'deleted'; continue }
    if (/^rename (from|to) /.test(line)) { cur.summary = 'renamed'; continue }
    if (/^Binary files /.test(line)) { cur.binary = true; cur.summary = 'binary'; continue }
    if (/^index [0-9a-f]/.test(line) || /^--- /.test(line) || /^\+\+\+ /.test(line)) continue
    if (/^@@ /.test(line)) {
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (/^\+/.test(line)) cur.adds++
    if (/^-/.test(line)) cur.dels++
    hunk.lines.push(line)
  }
  if (cur) files.push(cur)
  return files
}

export function filePatch(file) {
  return Array.isArray(file?.raw) ? file.raw.join('\n').replace(/\n+$/, '') : ''
}

export function summarizeFiles(files) {
  return files.map((f) => ({
    path: f.path,
    adds: f.adds,
    dels: f.dels,
    summary: f.summary,
    hunkCount: f.hunks.length,
    binary: f.binary,
  }))
}
