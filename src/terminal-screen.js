import { fitText, padVisible, stripAnsi, visibleLength } from './ui.js'

const MIN_COLUMNS = 32
const MIN_ROWS = 10

export function normalizeViewport(columns, rows) {
  const width = Math.max(MIN_COLUMNS, Number(columns) || 80)
  const height = Math.max(MIN_ROWS, Number(rows) || 24)
  return { width, height }
}

export function layoutTier(columns, rows) {
  const { width, height } = normalizeViewport(columns, rows)
  if (width < 64 || height < 18) return 'compact'
  if (width >= 112 && height >= 28) return 'wide'
  return 'regular'
}

function plainCell(value, width) {
  const text = stripAnsi(String(value ?? ''))
  return padVisible(fitText(text, width, { middle: true }), width)
}

function joinSides(left, right, width) {
  const safeLeft = fitText(left, Math.max(1, width - 1), { middle: true })
  const safeRight = fitText(right, Math.max(0, width - visibleLength(safeLeft) - 1), { middle: true })
  const gap = Math.max(1, width - visibleLength(safeLeft) - visibleLength(safeRight))
  return plainCell(safeLeft + ' '.repeat(gap) + safeRight, width)
}

export function headerLines({ width, height, model = 'default', mode = 'act', cwd = '~', branch = '', dirty = false, session = '', busy = false, connected = true } = {}) {
  const viewport = normalizeViewport(width, height)
  const tier = layoutTier(viewport.width, viewport.height)
  const state = busy ? 'working' : 'ready'
  const dot = connected ? '●' : '○'
  const brand = ' AKORITH'
  if (tier === 'compact') {
    return [
      joinSides(`${brand} · ${fitText(model, Math.max(8, viewport.width - 24), { middle: true })}`, `${dot} ${state}`, viewport.width),
    ]
  }
  const location = [fitText(cwd, Math.max(12, Math.floor(viewport.width * 0.52)), { middle: true }), branch && `${branch}${dirty ? '*' : ''}`]
    .filter(Boolean)
    .join(' · ')
  const identity = session ? `${brand} · ${fitText(session, 24, { middle: true })}` : brand
  return [
    joinSides(identity, `${dot} ${state}`, viewport.width),
    joinSides(` ${location}`, `${fitText(model, 30, { middle: true })} · ${mode}`, viewport.width),
  ]
}

function wrapEditorInput(input, cursor, width) {
  const chars = [...String(input ?? '')]
  const cursorIndex = Math.max(0, Math.min(Number(cursor) || 0, chars.length))
  const rows = [[]]
  let cursorRow = 0
  let cursorColumn = 0
  for (let index = 0; index <= chars.length; index++) {
    if (index === cursorIndex) {
      cursorRow = rows.length - 1
      cursorColumn = rows.at(-1).length
    }
    if (index === chars.length) break
    const char = chars[index]
    if (char === '\n') {
      rows.push([])
      continue
    }
    if (rows.at(-1).length >= width) rows.push([])
    rows.at(-1).push(char)
  }
  return { rows: rows.map((row) => row.join('')), cursorRow, cursorColumn }
}

function boxBorder(left, fill, right, width, label = '') {
  const inner = Math.max(0, width - 2)
  const tag = label ? ` ${fitText(label, Math.max(0, inner - 2))} ` : ''
  return left + tag + fill.repeat(Math.max(0, inner - visibleLength(tag))) + right
}

export function composerLayout({
  width,
  height,
  input = '',
  cursor = 0,
  model = 'default',
  mode = 'act',
  usage = '0 tokens',
  context = 'provider',
  queue = 0,
  busy = false,
} = {}) {
  const viewport = normalizeViewport(width, height)
  const tier = layoutTier(viewport.width, viewport.height)
  const outerWidth = Math.max(MIN_COLUMNS, viewport.width)
  const contentWidth = Math.max(8, outerWidth - 6)
  const wrapped = wrapEditorInput(input, cursor, contentWidth)
  const maxInputRows = tier === 'compact' ? Math.max(1, Math.min(3, viewport.height - 7)) : Math.max(2, Math.min(6, Math.floor(viewport.height / 3)))
  const firstVisible = Math.max(0, Math.min(wrapped.cursorRow - maxInputRows + 1, Math.max(0, wrapped.rows.length - maxInputRows)))
  const visibleRows = wrapped.rows.slice(firstVisible, firstVisible + maxInputRows)
  while (visibleRows.length < Math.min(2, maxInputRows)) visibleRows.push('')
  const lines = [boxBorder('╭', '─', '╮', outerWidth, busy ? 'Working' : 'Message')]
  visibleRows.forEach((row, index) => {
    const marker = index === 0 && firstVisible === 0 ? '› ' : '  '
    lines.push(`│ ${marker}${padVisible(row, contentWidth)} │`)
  })
  lines.push(boxBorder('╰', '─', '╯', outerWidth))
  const status = tier === 'compact'
    ? `${fitText(model, Math.max(8, outerWidth - 24), { middle: true })} · ${mode} · ${usage}`
    : `${model} · ${mode} · ctx ${context} · ${usage}${queue ? ` · queued ${queue}` : ''}`
  lines.push(plainCell(` ${status}`, outerWidth))
  if (tier !== 'compact') lines.push(plainCell(' Enter send · Shift+Enter newline · Ctrl+P commands · Ctrl+C cancel', outerWidth))
  const inputRow = 1 + wrapped.cursorRow - firstVisible
  const inputColumn = 4 + wrapped.cursorColumn
  return {
    lines,
    cursorRow: Math.max(1, Math.min(inputRow, lines.length - 3)),
    cursorColumn: Math.max(4, Math.min(inputColumn, outerWidth - 2)),
    firstVisible,
    tier,
  }
}

export function fitScreenLine(value, width) {
  const plain = stripAnsi(String(value ?? ''))
  return plainCell(plain, normalizeViewport(width, MIN_ROWS).width)
}

