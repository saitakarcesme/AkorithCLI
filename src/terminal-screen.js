import { format } from 'node:util'
import {
  bold,
  cyan,
  dim,
  faint,
  fitText,
  gradient,
  green,
  padVisible,
  sliceVisible,
  stripAnsi,
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
  const boxLines = [boxBorder('╭', '─', '╮', outerWidth, busy ? 'Working' : 'Message')]
  visibleRows.forEach((row, index) => {
    const marker = index === 0 && firstVisible === 0 ? '› ' : '  '
    boxLines.push(`│ ${marker}${padVisible(row, contentWidth)} │`)
  })
  boxLines.push(boxBorder('╰', '─', '╯', outerWidth))
  const status = tier === 'compact'
    ? `${fitText(model, Math.max(8, outerWidth - 24), { middle: true })} · ${mode} · ${usage}`
    : `${model} · ${mode} · ctx ${context} · ${usage}${queue ? ` · queued ${queue}` : ''}`
  boxLines.push(plainCell(` ${status}`, outerWidth))
  if (tier !== 'compact') boxLines.push(plainCell(' Enter send · Shift+Enter newline · Ctrl+P commands · Ctrl+C cancel', outerWidth))
  const lines = boxLines.map((line) => ansiCell(indent + line, viewport.width))
  const inputRow = 1 + wrapped.cursorRow - firstVisible
  const inputColumn = left + 4 + wrapped.cursorColumn
  return {
    lines,
    cursorRow: Math.max(1, Math.min(inputRow, lines.length - 3)),
    cursorColumn: Math.max(left + 4, Math.min(inputColumn, left + outerWidth - 2)),
    firstVisible,
    tier,
  }
}

export function fitScreenLine(value, width) {
  return ansiCell(value, normalizeViewport(width, MIN_ROWS).width)
}

export function splashLines({ width, height, version = '', model = 'default', cwd = '~' } = {}) {
  const viewport = normalizeViewport(width, height)
  const tier = layoutTier(viewport.width, viewport.height)
  const lines = []
  if (tier === 'compact') {
    lines.push(gradient(bold('AKORITH')))
    lines.push(dim('Agent workspace'))
    lines.push('')
    lines.push(`${violet('›')} ${text('Start typing to begin')}`)
    lines.push(`${faint('/')} ${dim('help · model · sessions · review')}`)
    return lines
  }
  const cardWidth = Math.min(tier === 'wide' ? 92 : 72, viewport.width - 4)
  const inner = cardWidth - 4
  const row = (value = '') => faint('│ ') + ansiCell(value, inner) + faint(' │')
  lines.push(faint('╭' + '─'.repeat(cardWidth - 2) + '╮'))
  lines.push(row())
  lines.push(row(`${gradient(bold('AKORITH'))} ${faint(version ? `v${version}` : '')}`))
  lines.push(row(yellow(bold('Your agent workspace is ready.'))))
  lines.push(row(dim('Claude, Codex, and OpenCode in one responsive terminal.')))
  lines.push(row())
  lines.push(row(`${cyan('↵')} ${text(bold('Send a prompt'))}       ${faint('Enter')}`))
  lines.push(row(`${violet('⌘')} ${text(bold('Command palette'))}   ${faint('Ctrl+P')}`))
  lines.push(row(`${green('●')} ${text(bold('Switch model'))}      ${faint('/model')}`))
  lines.push(row(`${faint('◫')} ${text(bold('Resume session'))}    ${faint('/sessions')}`))
  lines.push(row())
  lines.push(row(`${faint('model')} ${dim(fitText(model, Math.max(12, inner - 16), { middle: true }))}`))
  lines.push(row(`${faint('cwd  ')} ${dim(fitText(cwd, Math.max(12, inner - 16), { middle: true }))}`))
  lines.push(row())
  lines.push(faint('╰' + '─'.repeat(cardWidth - 2) + '╯'))
  return lines
}

function centerBlock(lines, width, height) {
  const top = Math.max(0, Math.floor((height - lines.length) / 2))
  const out = Array(top).fill('')
  for (const line of lines.slice(0, height)) {
    const left = Math.max(0, Math.floor((width - visibleLength(line)) / 2))
    out.push(' '.repeat(left) + line)
  }
  return out.slice(0, height)
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
  context = 'provider',
  queue = 0,
  transcript = [],
  overlay = null,
  notice = '',
  spinner = '',
} = {}) {
  const viewport = normalizeViewport(width, height)
  const header = headerLines({ ...viewport, model, mode, cwd, branch, dirty, session, busy, connected })
  const composer = composerLayout({ ...viewport, input, cursor, model, mode, usage, context, queue, busy })
  const separator = fitScreenLine(faint('─'.repeat(viewport.width)), viewport.width)
  const fixedRows = header.length + 1 + composer.lines.length
  const bodyHeight = Math.max(1, viewport.height - fixedRows)
  let bodySource
  if (Array.isArray(overlay)) {
    bodySource = centerBlock(overlay, viewport.width, bodyHeight)
  } else if (transcript.length) {
    bodySource = transcript.slice(-(bodyHeight - (notice ? 1 : 0) - (spinner ? 1 : 0)))
  } else {
    bodySource = centerBlock(splashLines({ ...viewport, version, model, cwd }), viewport.width, bodyHeight)
  }
  if (notice) bodySource.push(notice)
  if (spinner) bodySource.push(spinner)
  const body = bodySource.slice(-bodyHeight).map((line) => fitScreenLine(line, viewport.width))
  while (body.length < bodyHeight) body.unshift(' '.repeat(viewport.width))
  const composerStart = header.length + 1 + bodyHeight
  const lines = [
    ...header.map((line, index) => fitScreenLine(index === 0 ? violet(bold(line)) : dim(line), viewport.width)),
    separator,
    ...body,
    ...composer.lines.map((line, index) => fitScreenLine(index <= composer.lines.length - 3 ? faint(line) : dim(line), viewport.width)),
  ]
  return {
    lines: lines.slice(0, viewport.height),
    cursorRow: Math.min(viewport.height, composerStart + composer.cursorRow + 1),
    cursorColumn: Math.min(viewport.width, composer.cursorColumn + 1),
    tier: composer.tier,
    bodyHeight,
  }
}

let activeScreen = null

export function getActiveTerminalScreen() {
  return activeScreen
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
    this.maxTranscriptRows = 4000
  }

  dimensions() {
    return normalizeViewport(this.output.columns || process.env.COLUMNS, this.output.rows || process.env.LINES)
  }

  start() {
    if (this.started || !this.output.isTTY) return false
    this.started = true
    activeScreen = this
    this.output.write('\x1b[?1049h\x1b[?25l')
    this.renderNow()
    return true
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.renderPending = false
    if (activeScreen === this) activeScreen = null
    this.output.write('\x1b[?25h\x1b[0m\x1b[?1049l')
  }

  append(...values) {
    const value = values.length > 1 ? format(...values) : String(values[0] ?? '')
    this.transcript.push(...value.replace(/\r/g, '').split('\n'))
    if (this.transcript.length > this.maxTranscriptRows) {
      this.transcript.splice(0, this.transcript.length - this.maxTranscriptRows)
    }
    this.scheduleRender()
  }

  clear() {
    this.transcript = []
    this.notice = ''
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

  scheduleRender() {
    if (!this.started || this.renderPending) return
    this.renderPending = true
    setImmediate(() => {
      this.renderPending = false
      this.renderNow()
    })
  }

  renderNow() {
    if (!this.started) return
    const frame = buildFrame({ ...this.dimensions(), ...this.state(), transcript: this.transcript, overlay: this.overlay, notice: this.notice, spinner: this.spinner })
    const body = frame.lines.map((line) => `${line}\x1b[K`).join('\n')
    this.output.write(`\x1b[?25l\x1b[H${body}\x1b[J\x1b[${frame.cursorRow};${frame.cursorColumn}H\x1b[?25h`)
  }
}
