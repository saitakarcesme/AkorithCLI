// Shared tool-call card rendering for the provider renderers.
// Each tool call renders as a compact header line:
//   ▸ <icon> <title>  <status chip>  <subtitle>
// followed (optionally) by an indented body block. Cards collapse noisy
// tool output to a header-only summary by default — matching OpenCode's
// collapsible card behavior in Akorith's scrollback-first style.
//
// Status chips: pending ◐ (violet) · running ◐ (violet, animated via tick)
// · completed ✓ (green) · error ✗ (red).
// Icons are single glyphs chosen to be legible in any font.

import { bold, dim, faint, green, red, violet, yellow, text } from './ui.js'

export const TOOL_ICONS = {
  exec: '⚙',
  bash: '⚙',
  shell: '⚙',
  patch: '✎',
  write: '✎',
  edit: '✎',
  read: '▸',
  glob: '◇',
  search: '⌕',
  grep: '⌕',
  list: '☰',
  question: '?',
  task: '◆',
  skill: '★',
  todos: '☑',
  todo: '☑',
  default: '·',
}

export const TOOL_TITLES = {
  exec: 'shell',
  bash: 'shell',
  shell: 'shell',
  patch: 'edit',
  write: 'write',
  edit: 'edit',
  read: 'read',
  glob: 'glob',
  search: 'search',
  grep: 'search',
  list: 'list',
  question: 'question',
  task: 'task',
  skill: 'skill',
  todos: 'todos',
  todo: 'todos',
}

export function toolIcon(name) {
  return TOOL_ICONS[name] || TOOL_ICONS.default
}

export function toolTitle(name) {
  return TOOL_TITLES[name] || name
}

// status: 'pending' | 'running' | 'completed' | 'error'
export function statusChip(status) {
  if (status === 'completed') return green('✓')
  if (status === 'error') return red('✗')
  if (status === 'pending') return violet('○')
  return violet('◐') // running
}

// Render the header line for a tool card. Returns a string (no newline).
//   ▸ ⚙ shell  ✓  ls -la docs
export function toolCardHeader({ name, status, subtitle = '', title }) {
  const icon = toolIcon(name)
  const t = title || toolTitle(name)
  const chip = statusChip(status)
  const head = violet('  ▸ ') + faint(icon) + ' ' + bold(t) + '  ' + chip
  if (subtitle) return head + faint('   ' + subtitle)
  return head
}

// Render a tool-card body block (already-indented lines, wrapped to width).
// Each line gets a faint `│` left border. Pass an array of lines.
export function toolCardBody(lines, { width = 100 } = {}) {
  const out = []
  for (const raw of lines) {
    const line = String(raw)
    if (!line.trim()) { out.push(faint('  │')); continue }
    // naive wrap
    const visible = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    if (visible.length <= width - 4) {
      out.push(faint('  │ ') + line)
    } else {
      const words = line.split(' ')
      let row = ''
      for (const w of words) {
        if (!row) row = w
        else if ((row + ' ' + w).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length <= width - 4) row += ' ' + w
        else { out.push(faint('  │ ') + row); row = w }
      }
      if (row) out.push(faint('  │ ') + row)
    }
  }
  out.push(faint('  ╵'))
  return out
}