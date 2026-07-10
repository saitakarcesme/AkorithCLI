import { format } from 'node:util'
import {
  bold,
  cyan,
  dim,
  faint,
  fitText,
  green,
  padVisible,
  pixelLogoLines,
  sliceVisible,
  splitGraphemes,
  stripAnsi,
  terminalCellWidth,
  text,
  violet,
  visibleLength,
  yellow,
} from './ui.js'

const MIN_COLUMNS = 20
const MIN_ROWS = 8

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

function ansiCell(value, width) {
  const content = visibleLength(value) > width ? sliceVisible(value, width) : String(value ?? '')
  return content + ' '.repeat(Math.max(0, width - visibleLength(content)))
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
  if (tier === 'compact') {
    return [
      joinSides(` ${fitText(session || model, Math.max(8, viewport.width - 14), { middle: true })}`, `${dot} ${state}`, viewport.width),
    ]
  }
  const location = [fitText(cwd, Math.max(12, Math.floor(viewport.width * 0.52)), { middle: true }), branch && `${branch}${dirty ? '*' : ''}`]
    .filter(Boolean)
    .join(' · ')
  const identity = ` ${fitText(session || 'new session', 32, { middle: true })}`
  return [
    joinSides(identity, `${dot} ${state}`, viewport.width),
    joinSides(` ${location}`, `│ ${fitText(model, 30, { middle: true })} · ${mode}`, viewport.width),
  ]
}

export function contextUsageMeter(total, context, width = 8) {
  const raw = String(context || '').trim().toLowerCase()
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([km])$/)
  if (!match) return `ctx ${raw || 'provider'}`
  const factor = match[2] === 'm' ? 1_000_000 : 1_000
  const limit = Number(match[1]) * factor
  const ratio = Math.max(0, Math.min(1, (Number(total) || 0) / limit))
  const size = Math.max(3, Number(width) || 8)
  const used = Math.round(ratio * size)
  const warning = ratio >= 0.95 ? '⚠' : ratio >= 0.8 ? '!' : ''
  return `ctx [${'█'.repeat(used)}${'░'.repeat(size - used)}] ${Math.round(ratio * 100)}%${warning}`
}

function wrapEditorInput(input, cursor, width) {
  const chars = splitGraphemes(input)
  const cursorIndex = Math.max(0, Math.min(Number(cursor) || 0, chars.length))
  const rows = [[]]
  const rowWidths = [0]
  let cursorRow = 0
  let cursorColumn = 0
  for (let index = 0; index <= chars.length; index++) {
    if (index === cursorIndex) {
      cursorRow = rows.length - 1
      cursorColumn = rowWidths.at(-1)
    }
    if (index === chars.length) break
    const char = chars[index]
    if (char === '\n') {
      rows.push([])
      rowWidths.push(0)
      continue
    }
    const cellWidth = terminalCellWidth(char)
    if (rowWidths.at(-1) + cellWidth > width) {
      rows.push([])
      rowWidths.push(0)
    }
    rows.at(-1).push(char)
    rowWidths[rowWidths.length - 1] += cellWidth
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
  usageTotal = 0,
  context = 'provider',
  queue = 0,
  busy = false,
  label = 'Message',
  showStatus = true,
} = {}) {
  const viewport = normalizeViewport(width, height)
  const tier = layoutTier(viewport.width, viewport.height)
  const outerWidth = tier === 'compact'
    ? viewport.width
    : Math.max(44, Math.min(126, viewport.width - 4))
  const left = Math.max(0, Math.floor((viewport.width - outerWidth) / 2))
  const indent = ' '.repeat(left)
  const contentWidth = Math.max(8, outerWidth - 6)
  const wrapped = wrapEditorInput(input, cursor, contentWidth)
  const maxInputRows = tier === 'compact' ? Math.max(1, Math.min(3, viewport.height - 7)) : Math.max(2, Math.min(6, Math.floor(viewport.height / 3)))
  const firstVisible = Math.max(0, Math.min(wrapped.cursorRow - maxInputRows + 1, Math.max(0, wrapped.rows.length - maxInputRows)))
  const visibleRows = wrapped.rows.slice(firstVisible, firstVisible + maxInputRows)
  while (visibleRows.length < Math.min(2, maxInputRows)) visibleRows.push('')
  const boxLines = [boxBorder('╭', '─', '╮', outerWidth, busy ? 'Working' : label)]
  visibleRows.forEach((row, index) => {
    const marker = index === 0 && firstVisible === 0 ? '› ' : '  '
    boxLines.push(`│ ${marker}${padVisible(row, contentWidth)} │`)
  })
  boxLines.push(boxBorder('╰', '─', '╯', outerWidth))
  if (showStatus) {
    const modelBudget = Math.max(8, outerWidth - visibleLength(mode) - visibleLength(usage) - 10)
    const status = `${fitText(model, modelBudget, { middle: true })} · ${mode} · ${usage}${queue ? ` · +${queue}` : ''}`
    boxLines.push(plainCell(` ${status}`, outerWidth))
  }
  const lines = boxLines.map((line) => ansiCell(indent + line, viewport.width))
  const inputRow = 1 + wrapped.cursorRow - firstVisible
  const inputColumn = left + 4 + wrapped.cursorColumn
  return {
    lines,
    cursorRow: Math.max(1, Math.min(inputRow, visibleRows.length)),
    cursorColumn: Math.max(left + 4, Math.min(inputColumn, left + outerWidth - 2)),
    firstVisible,
    tier,
  }
}

export function fitScreenLine(value, width) {
  return ansiCell(value, normalizeViewport(width, MIN_ROWS).width)
}

export function compactComposerModel(value) {
  const parts = stripAnsi(value).split(' · ').map((part) => part.trim()).filter(Boolean)
  if (/^(?:olympus|atlantis|gaia|local)$/i.test(parts[0] || '')) parts.shift()
  if (parts.length) parts[0] = parts[0].replace(/^(?:codex|claude|opencode(?:-go)?|ollama)\//i, '')
  return parts.join(' · ') || 'default'
}

export function splashLines({ width, height, version = '', model = 'default', cwd = '~' } = {}) {
  const viewport = normalizeViewport(width, height)
  const tier = layoutTier(viewport.width, viewport.height)
  const lines = []
  if (tier === 'compact') {
    lines.push(yellow(bold('Your workspace is ready.')))
    lines.push(`${violet('›')} ${text('Start typing to begin')}`)
    lines.push(faint('/help · /model · /sessions'))
    return lines
  }
  lines.push(yellow(bold('Your agent workspace is ready.')))
  lines.push(dim('Claude, Codex, and OpenCode in one responsive terminal.'))
  lines.push('')
  lines.push(`${cyan('›')} ${text(bold('Start typing to begin'))}`)
  lines.push(faint('/help · /model · /sessions · /review'))
  return lines
}

function topBlock(lines, width, height, { center = true } = {}) {
  const out = []
  for (const line of lines.slice(0, height)) {
    const left = center ? Math.max(0, Math.floor((width - visibleLength(line)) / 2)) : 0
    out.push(' '.repeat(left) + line)
  }
  while (out.length < height) out.push('')
  return out
}

export function brandHeaderLines({ width, height } = {}) {
  const viewport = normalizeViewport(width, height)
  const maxRows = viewport.height < 12 ? 1 : viewport.height < 24 ? 3 : 6
  return pixelLogoLines(viewport.width, maxRows).map((line) => {
    const left = Math.max(0, Math.floor((viewport.width - visibleLength(line)) / 2))
    return ansiCell(' '.repeat(left) + line, viewport.width)
  })
}

export function sidebarLines({
  width,
  height,
  model = 'default',
  mode = 'act',
  cwd = '~',
  branch = '',
  dirty = false,
  session = 'new session',
  busy = false,
  connected = true,
  usage = '0 tokens',
  usageTotal = 0,
  context = 'provider',
  queue = 0,
  todos = [],
} = {}) {
  const safeWidth = Math.max(24, Number(width) || 32)
  const safeHeight = Math.max(1, Number(height) || 20)
  const inner = safeWidth - 2
  const row = (value = '') => ansiCell(` ${value}`, safeWidth)
  const section = (label) => ansiCell(` ${label} ${'─'.repeat(Math.max(0, inner - visibleLength(label) - 1))}`, safeWidth)
  const state = busy ? yellow('● working') : connected ? green('● ready') : faint('○ offline')
  const rows = [
    section('WORKSPACE'),
    row(state),
    row(faint('model')),
    row(text(fitText(model, inner - 1, { middle: true }))),
    row(`${faint('mode')} ${text(mode)}${queue ? `  ${yellow(`queued ${queue}`)}` : ''}`),
    row(faint(contextUsageMeter(usageTotal, context, 6))),
    row(`${faint('tokens')} ${text(usage)}`),
    row(),
    section('SESSION'),
    row(text(fitText(session, inner - 1, { middle: true }))),
    row(faint(fitText(cwd, inner - 1, { middle: true }))),
  ]
  if (branch) rows.push(row(violet(fitText(`${branch}${dirty ? '*' : ''}`, inner - 1, { middle: true }))))
  rows.push(row(), section(`TODO ${todos.length ? `${todos.filter((todo) => todo.done).length}/${todos.length}` : ''}`.trim()))
  if (!todos.length) {
    rows.push(row(faint('No active plan')))
  } else {
    for (const todo of todos.slice(0, Math.max(1, safeHeight - rows.length - 1))) {
      const mark = todo.done ? green('✓') : todo.active ? yellow('●') : faint('○')
      rows.push(row(`${mark} ${fitText(todo.text, Math.max(4, inner - 3))}`))
    }
  }
  while (rows.length < safeHeight) rows.push(row())
  return rows.slice(0, safeHeight)
}

export function overlayWindow(lines, height) {
  const source = Array.isArray(lines) ? lines : []
  const limit = Math.max(1, Number(height) || 1)
  if (source.length <= limit) return source
  if (limit <= 2) return source.slice(0, limit)
  const top = source[0]
  const bottom = source.at(-1)
  const body = source.slice(1, -1)
  const selected = Math.max(0, body.findIndex((line) => stripAnsi(line).includes('▸')))
  const capacity = limit - 2
  const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), body.length - capacity))
  return [top, ...body.slice(start, start + capacity), bottom]
}

function buildBodyLines({
  width,
  height,
  version,
  model,
  cwd,
  transcript,
  transcriptOffset,
  overlay,
  notice,
  spinner,
}) {
  const safeHeight = Math.max(1, height)
  const trailing = [notice, spinner].filter(Boolean)
  const capacity = Math.max(0, safeHeight - trailing.length)
  let content
  if (Array.isArray(overlay)) {
    content = overlayWindow(overlay, capacity).slice(0, capacity)
  } else if (transcript.length) {
    const offset = Math.max(0, Math.min(Number(transcriptOffset) || 0, Math.max(0, transcript.length - 1)))
    const end = Math.max(0, transcript.length - offset)
    content = transcript.slice(Math.max(0, end - capacity), end)
  } else {
    content = topBlock(splashLines({ width, height: safeHeight, version, model, cwd }), width, capacity).slice(0, capacity)
  }
  const rows = [...content, ...trailing].map((line) => fitScreenLine(line, width))
  while (rows.length < safeHeight) rows.push(' '.repeat(width))
  return rows.slice(0, safeHeight)
}

export function buildFrame({
  width,
  height,
  version = '',
  model = 'default',
  mode = 'act',
  cwd = '~',
  branch = '',
  dirty = false,
  session = '',
  busy = false,
  connected = true,
  input = '',
  cursor = 0,
  usage = '0 tokens',
  usageTotal = 0,
  context = 'provider',
  queue = 0,
  composerLabel = 'Message',
  transcript = [],
  transcriptOffset = 0,
  overlay = null,
  notice = '',
  spinner = '',
  todos = [],
} = {}) {
  const viewport = normalizeViewport(width, height)
  const brand = brandHeaderLines(viewport)
  const header = headerLines({ ...viewport, model, mode, cwd, branch, dirty, session, busy, connected })
  const separator = fitScreenLine(faint('─'.repeat(viewport.width)), viewport.width)
  const top = [
    ...brand,
    ...header.map((line, index) => fitScreenLine(index === 0 ? violet(bold(line)) : dim(line), viewport.width)),
    separator,
  ]
  const sidebarVisible = viewport.width >= 144 && viewport.height >= 28
  const sidebarWidth = sidebarVisible ? Math.max(30, Math.min(38, Math.floor(viewport.width * 0.24))) : 0
  const mainWidth = sidebarVisible ? viewport.width - sidebarWidth - 1 : viewport.width
  const composer = composerLayout({
    width: mainWidth,
    height: viewport.height,
    input,
    cursor,
    model: compactComposerModel(model),
    mode,
    usage,
    usageTotal,
    context,
    queue,
    busy,
    label: composerLabel,
    showStatus: !sidebarVisible,
  })
  const paneHeight = Math.max(1, viewport.height - top.length)
  const bodyHeight = Math.max(1, paneHeight - composer.lines.length)
  const body = buildBodyLines({
    width: mainWidth,
    height: bodyHeight,
    version,
    model,
    cwd,
    transcript,
    transcriptOffset,
    overlay,
    notice,
    spinner,
  })
  const composerRows = composer.lines.map((line, index) => fitScreenLine(index < composer.lines.length - (sidebarVisible ? 0 : 1) ? faint(line) : dim(line), mainWidth))
  const mainPane = [...body, ...composerRows]
  while (mainPane.length < paneHeight) mainPane.push(' '.repeat(mainWidth))
  let pane
  if (sidebarVisible) {
    const sidebar = sidebarLines({
      width: sidebarWidth,
      height: paneHeight,
      model,
      mode,
      cwd,
      branch,
      dirty,
      session,
      busy,
      connected,
      usage,
      usageTotal,
      context,
      queue,
      todos,
    })
    pane = mainPane.map((line, index) => ansiCell(line, mainWidth) + faint('│') + ansiCell(sidebar[index], sidebarWidth))
  } else {
    pane = mainPane
  }
  const composerStart = top.length + bodyHeight
  const lines = [...top, ...pane]
  return {
    lines: lines.slice(0, viewport.height),
    cursorRow: Math.min(viewport.height, composerStart + composer.cursorRow + 1),
    cursorColumn: Math.min(viewport.width, composer.cursorColumn + 1),
    tier: composer.tier,
    bodyHeight,
    sidebarVisible,
  }
}

let activeScreen = null

export function getActiveTerminalScreen() {
  return activeScreen
}

export function extractPlanTodos(lines = []) {
  const todos = []
  let planMode = false
  const upsert = (textValue, state = {}) => {
    const clean = stripAnsi(textValue).replace(/\s+/g, ' ').trim()
    if (!clean) return
    const key = clean.toLowerCase()
    const existing = todos.find((todo) => todo.text.toLowerCase() === key)
    if (existing) Object.assign(existing, state)
    else todos.push({ text: clean, done: false, active: false, ...state })
  }
  for (const raw of lines) {
    const plain = stripAnsi(raw).trim()
    if (/^(?:#{1,4}\s*)?(?:implementation\s+)?(?:plan|todo|tasks|yapılacaklar)\s*:?[\s]*$/i.test(plain)) {
      planMode = true
      continue
    }
    const checkbox = plain.match(/^(?:[-*•]\s*)?\[([ xX>])\]\s+(.+)$/)
    if (checkbox) {
      upsert(checkbox[2], { done: /x/i.test(checkbox[1]), active: checkbox[1] === '>' })
      continue
    }
    const symbol = plain.match(/^([☐☑◐✓○●])\s+(.+)$/)
    if (symbol) {
      const key = symbol[2].replace(/\s+/g, ' ').trim().toLowerCase()
      const knownTask = todos.some((todo) => todo.text.toLowerCase() === key)
      if (planMode || knownTask) {
        upsert(symbol[2], { done: /[☑✓]/.test(symbol[1]), active: /[◐●]/.test(symbol[1]) })
      }
      continue
    }
    if (!planMode) continue
    const item = plain.match(/^(?:\d+[.)]|[-*•])\s+(.+)$/)
    if (item) {
      upsert(item[1])
      continue
    }
    if (plain && todos.length) planMode = false
  }
  return todos.slice(-12)
}

export class TerminalScreen {
  constructor({ output = process.stdout, state = () => ({}) } = {}) {
    this.output = output
    this.state = state
    this.transcript = []
    this.overlay = null
    this.notice = ''
    this.spinner = ''
    this.started = false
    this.renderPending = false
    this.renderTimer = null
    this.maxTranscriptRows = 4000
    this.transcriptOffset = 0
    this.todos = []
  }

  dimensions() {
    return normalizeViewport(this.output.columns || process.env.COLUMNS, this.output.rows || process.env.LINES)
  }

  start() {
    if (this.started || !this.output.isTTY) return false
    this.started = true
    activeScreen = this
    this.output.write('\x1b[?1049h\x1b[?6l\x1b[r\x1b[2J\x1b[H\x1b[?25l')
    this.renderNow()
    return true
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.renderPending = false
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = null
    if (activeScreen === this) activeScreen = null
    this.output.write('\x1b[?6l\x1b[r\x1b[?25h\x1b[0m\x1b[?1049l')
  }

  append(...values) {
    const value = values.length > 1 ? format(...values) : String(values[0] ?? '')
    this.transcript.push(...value.replace(/\r/g, '').split('\n'))
    if (this.transcript.length > this.maxTranscriptRows) {
      this.transcript.splice(0, this.transcript.length - this.maxTranscriptRows)
    }
    this.todos = extractPlanTodos(this.transcript)
    this.transcriptOffset = 0
    this.scheduleRender()
  }

  clear() {
    this.transcript = []
    this.transcriptOffset = 0
    this.notice = ''
    this.todos = []
    this.scheduleRender()
  }

  setOverlay(lines) {
    this.overlay = Array.isArray(lines) ? lines : null
    this.scheduleRender()
  }

  setNotice(value = '') {
    this.notice = String(value)
    this.scheduleRender()
  }

  setSpinner(value = '') {
    this.spinner = String(value)
    this.scheduleRender()
  }

  setTodos(todos = []) {
    this.todos = todos.map((todo) => typeof todo === 'string' ? { text: todo, done: false, active: false } : { ...todo })
    this.scheduleRender()
  }

  clearTodos() {
    this.todos = []
    this.scheduleRender()
  }

  scroll(delta) {
    const amount = Number(delta) || 0
    this.transcriptOffset = Math.max(0, Math.min(this.transcript.length - 1, this.transcriptOffset + amount))
    this.notice = this.transcriptOffset ? `scrollback · ${this.transcriptOffset} rows from latest · PageDown returns` : ''
    this.scheduleRender()
  }

  jumpTo(index) {
    const target = Math.max(0, Math.min(Number(index) || 0, Math.max(0, this.transcript.length - 1)))
    this.transcriptOffset = Math.max(0, this.transcript.length - target - 1)
    this.overlay = null
    this.notice = `timeline · row ${target + 1}/${this.transcript.length}`
    this.scheduleRender()
  }

  searchTranscript(query) {
    const needle = String(query || '').toLowerCase()
    if (!needle) return -1
    for (let index = this.transcript.length - 1; index >= 0; index--) {
      if (stripAnsi(this.transcript[index]).toLowerCase().includes(needle)) {
        this.jumpTo(index)
        return index
      }
    }
    this.notice = `timeline · no match for ${query}`
    this.scheduleRender()
    return -1
  }

  timelineLines(limit = 12) {
    const width = this.dimensions().width
    const entries = this.transcript
      .map((line, index) => ({ index, line: stripAnsi(line).trim() }))
      .filter((entry) => entry.line)
      .slice(-Math.max(1, limit))
    const inner = Math.max(8, width - 4)
    const lines = [boxBorder('╭', '─', '╮', width, 'Timeline')]
    if (!entries.length) lines.push(`│ ${padVisible('No transcript rows yet.', inner)} │`)
    for (const entry of entries) {
      const label = String(entry.index + 1).padStart(4)
      lines.push(`│ ${padVisible(`${label}  ${fitText(entry.line, Math.max(4, inner - 6), { middle: true })}`, inner)} │`)
    }
    lines.push(boxBorder('╰', '─', '╯', width, '/timeline <row|tail|search text>'))
    return lines
  }

  scheduleRender() {
    if (!this.started || this.renderPending) return
    this.renderPending = true
    this.renderTimer = setTimeout(() => {
      this.renderPending = false
      this.renderTimer = null
      this.renderNow()
    }, 16)
    this.renderTimer.unref?.()
  }

  renderNow() {
    if (!this.started) return
    const frame = buildFrame({ ...this.dimensions(), ...this.state(), transcript: this.transcript, transcriptOffset: this.transcriptOffset, overlay: this.overlay, notice: this.notice, spinner: this.spinner, todos: this.todos })
    const body = frame.lines.map((line) => `${line}\x1b[K`).join('\n')
    this.output.write(`\x1b[?25l\x1b[?6l\x1b[r\x1b[H${body}\x1b[J\x1b[${frame.cursorRow};${frame.cursorColumn}H\x1b[?25h`)
  }
}
