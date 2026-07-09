// Command catalog for the Akorith workspace — shared by /help and the ctrl+p
// command palette. Each entry: { cmd, title, desc }.

export const COMMAND_CATALOG = [
  { cmd: '/model', title: 'Switch model', desc: 'Open the model picker (↑/↓ to choose)' },
  { cmd: '/model <spec>', title: 'Switch model directly', desc: 'e.g. /model claude/sonnet, /model gpt 5.5 high' },
  { cmd: '/models', title: 'List providers', desc: 'Show installed providers and how to address them' },
  { cmd: '/mode', title: 'Set permission mode', desc: 'view (read-only) or act (can edit)' },
  { cmd: '/mode <m>', title: 'Set mode directly', desc: '/mode view or /mode act' },
  { cmd: '/thinking', title: 'Reasoning visibility', desc: 'hide · minimal · show — model reasoning display' },
  { cmd: '/thinking <m>', title: 'Set reasoning mode', desc: '/thinking hide|minimal|show' },
  { cmd: '/connect', title: 'Connections menu', desc: 'Toggle git, GitHub, npm integrations' },
  { cmd: '/connect <name> on|off', title: 'Toggle a connection', desc: '/connect github off' },
  { cmd: '/options', title: 'Inspect run options', desc: 'images, add-dir, json, search, sandbox' },
  { cmd: '/option <k> <v>', title: 'Set a run option', desc: '/option image ./shot.png, /option search on' },
  { cmd: '/sessions', title: 'Session picker', desc: 'Browse and resume saved sessions interactively' },
  { cmd: '/sessions --all', title: 'All sessions picker', desc: 'Browse sessions from every folder' },
  { cmd: '/resume', title: 'Resume last session', desc: 'Resume the most recently updated session' },
  { cmd: '/fork <id>', title: 'Fork a session', desc: 'Branch a session into fresh work' },
  { cmd: '/archive', title: 'Archive session', desc: 'Hide a session from the active list' },
  { cmd: '/unarchive', title: 'Unarchive session', desc: 'Restore an archived session' },
  { cmd: '/delete', title: 'Delete session', desc: 'Permanently remove a saved session' },
  { cmd: '/review', title: 'Review current diff', desc: 'Ask the model to review staged/uncommitted' },
  { cmd: '/doctor', title: 'Diagnose environment', desc: 'Check local CLIs, auth, global install' },
  { cmd: '/update', title: 'Update Akorith', desc: 'Reinstall akorith from this repo/npm' },
  { cmd: '/cd <dir>', title: 'Change directory', desc: 'Switch the active working directory' },
  { cmd: '/new', title: 'Fresh start', desc: 'Reset all provider threads' },
  { cmd: '/clear', title: 'Clear screen', desc: 'Clear the terminal and re-show status' },
  { cmd: '/help', title: 'Show help', desc: 'List every command Akorith understands' },
  { cmd: '/exit', title: 'Exit Akorith', desc: 'Leave the workspace' },
  { cmd: '!<command>', title: 'Run shell', desc: 'Run a shell command in place (e.g. !git status)' },
]

// Fuzzy match: every char of `query` appears in `target` in order.
export function fuzzyMatch(query, target) {
  const q = String(query || '').toLowerCase()
  if (!q) return true
  const t = String(target).toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++
  }
  return i === q.length
}

export function fuzzyRank(query, target) {
  // Rank by consecutive matches & position; lower score = better.
  const q = String(query || '').toLowerCase()
  if (!q) return 0
  const t = String(target).toLowerCase()
  let i = 0, score = 0, consecutive = 0, lastMatch = -2
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (j === lastMatch + 1) consecutive++
      else consecutive = 0
      score -= consecutive * 2
      if (i === 0) score -= 5 - Math.min(5, j) // earlier first match = better
      lastMatch = j
      i++
    }
  }
  if (i !== q.length) return Infinity
  return score
}

export function filterCatalog(query) {
  const trimmed = String(query || '').trim()
  if (!trimmed) return COMMAND_CATALOG.slice()
  const scored = COMMAND_CATALOG
    .map((entry) => {
      const hay = `${entry.cmd} ${entry.title} ${entry.desc}`
      const score = fuzzyRank(trimmed, hay)
      const ok = fuzzyMatch(trimmed, hay)
      return { entry, score: ok ? score : Infinity }
    })
    .filter((x) => x.score !== Infinity)
    .sort((a, b) => a.score - b.score)
  return scored.map((x) => x.entry)
}