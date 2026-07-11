// Terminal styling helpers. Zero dependencies — plain ANSI.
// Palette mirrors the akorith.space /cli page terminal mock: white text at
// varying opacities on near-black, emerald-400 checkmarks, violet accents.
// Colors + light/dark adaptation come from src/theme.js (which reads an
// optional ~/.akorith/theme.json and probes COLORFGBG).

import { palette, palette256, isLightBackground } from './theme.js'

const colorCapable =
  Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR !== undefined || process.env.AKORITH_COLOR === '1'
const enabled = process.env.NO_COLOR === undefined && colorCapable
const brandEnabled = process.env.AKORITH_MONO !== '1' && colorCapable
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '')
let terminalAdapter = null
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

export function setTerminalAdapter(adapter = null) {
  terminalAdapter = adapter
}

export function prefersReducedMotion() {
  return process.env.AKORITH_REDUCED_MOTION === '1' || process.env.REDUCE_MOTION === '1'
}

const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

// hex color with a 256-color fallback for terminals without truecolor
function fg(hex, fallback256) {
  if (!enabled) return (s) => String(s)
  if (truecolor) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`
  }
  return (s) => `\x1b[38;5;${fallback256}m${s}\x1b[39m`
}

export const bold = wrap(1, 22)
export const italic = wrap(3, 23)

// white at ~90% / ~50% / ~35% over the mock's near-black background
export const text = fg(palette.text, palette256.text)
export const dim = fg(palette.dim, palette256.dim)
export const faint = fg(palette.faint, palette256.faint)
export const accent = text
// violet brand pair from the page (violet-400 text, violet-500 cursor)
export const violet = fg(palette.violet, palette256.violet)
export const violetDeep = fg(isLightBackground ? '#7c3aed' : '#8b5cf6', 99)
// status colors as the page uses them (Tailwind 400s)
export const green = fg(palette.green, palette256.green) // emerald-400 — the ✓ lines
export const red = fg(palette.red, palette256.red)
export const yellow = fg(palette.yellow, palette256.yellow)
export const cyan = fg(palette.cyan, palette256.cyan) // sky-400 — hero gradient start

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

export function splitGraphemes(value) {
  const text_ = String(value ?? '')
  return graphemeSegmenter ? [...graphemeSegmenter.segment(text_)].map((part) => part.segment) : [...text_]
}

export function terminalCellWidth(character) {
  const value = String(character ?? '')
  if (!value) return 0
  if (/^[\u0000-\u001f\u007f-\u009f]$/u.test(value)) return 0
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]$/u.test(value)) return 0
  const code = value.codePointAt(0)
  if (/\p{Extended_Pictographic}/u.test(value)) return 2
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return 2
  if (
    code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  ) return 2
  return 1
}

export function terminalColumns(fallback = 80) {
  const value = Number(process.stdout.columns || process.env.COLUMNS || fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function terminalRows(fallback = 36) {
  const value = Number(process.stdout.rows || process.env.LINES || fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function visibleLength(value) {
  return splitGraphemes(stripAnsi(value)).reduce((total, character) => total + terminalCellWidth(character), 0)
}

function takeCells(value, width, { fromEnd = false } = {}) {
  const chars = splitGraphemes(value)
  if (fromEnd) chars.reverse()
  const out = []
  let size = 0
  for (const character of chars) {
    const cellWidth = terminalCellWidth(character)
    if (size + cellWidth > width) break
    out.push(character)
    size += cellWidth
  }
  if (fromEnd) out.reverse()
  return out.join('')
}

export function fitText(value, max, { middle = false } = {}) {
  const plain = stripAnsi(String(value ?? '')).replace(/\s+/g, ' ').trim()
  const width = Math.max(0, Number(max) || 0)
  if (visibleLength(plain) <= width) return plain
  if (width <= 0) return ''
  if (width === 1) return '…'
  if (middle && width > 8) {
    const headWidth = Math.ceil((width - 1) * 0.45)
    const tailWidth = Math.floor((width - 1) * 0.55)
    return `${takeCells(plain, headWidth)}…${takeCells(plain, tailWidth, { fromEnd: true })}`
  }
  const head = takeCells(plain, width - 1).replace(/\s+$/g, '')
  const lastSpace = head.lastIndexOf(' ')
  const cut = lastSpace >= Math.max(4, Math.floor(width * 0.55)) ? head.slice(0, lastSpace) : head
  return cut + '…'
}

export function padVisible(value, width) {
  const text_ = String(value ?? '')
  const size = visibleLength(text_)
  if (size > width) return fitText(text_, width)
  return text_ + ' '.repeat(Math.max(0, width - size))
}

export function wrapWords(value, width, { maxLines = Infinity } = {}) {
  const limit = Math.max(8, Number(width) || 80)
  const words = String(value ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  let line = ''
  for (const rawWord of words) {
    const word = visibleLength(rawWord) > limit ? fitText(rawWord, limit, { middle: true }) : rawWord
    if (!line) {
      line = word
    } else if (visibleLength(line) + 1 + visibleLength(word) <= limit) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
    if (lines.length >= maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (lines.length > maxLines) return lines.slice(0, maxLines)
  return lines.length ? lines : ['']
}

// Diff lines rendered as full-width bars: added/written code on an Akorith-green
// background, removed code on an Akorith-purple background. The bar fills the
// terminal width so runs of changes read as solid colored blocks, not grey text.
// On light backgrounds the solid bars are unreadable, so we fall back to
// foreground-only coloring (green `+` lines, red `-` lines) — still distinct,
// legible on white.
function diffBar(sign, content, bg, fg, bg256, widthOverride = null) {
  const raw = `${sign} ${content}`
  if (!enabled) return raw
  if (isLightBackground) {
    // Foreground-only: green for additions, red (reserved here, not for errors)
    // for deletions would conflict — use a muted purple for deletions on light.
    const hex = sign === '+' ? palette.green : palette.red
    const fb = sign === '+' ? palette256.green : palette256.red
    return fg(hex, fb)(raw)
  }
  const width = Math.min(widthOverride || terminalColumns(), 120)
  const body = raw.length >= width ? raw.slice(0, width) : raw.padEnd(width)
  if (truecolor) {
    return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${body}\x1b[0m`
  }
  return `\x1b[48;5;${bg256}m\x1b[38;5;255m${body}\x1b[0m`
}
// deep green bg, bright mint text
export const diffAdd = (content, width = null) => diffBar('+', content, [12, 72, 50], [191, 246, 213], 22, width)
// removed code is intentionally purple, not red; red is reserved for errors.
export const diffDel = (content, width = null) => diffBar('-', content, [58, 34, 110], [233, 213, 255], 54, width)

function surfaceBg(value, row = 0) {
  const text_ = String(value ?? '')
  if (!brandEnabled) return text_
  const colors = [
    [35, 34, 38],
    [33, 37, 35],
  ]
  const [r, g, b] = colors[row % colors.length]
  return `\x1b[48;2;${r};${g};${b}m${text_}\x1b[0m`
}

export function userMessageLines({ prompt = '', width = terminalColumns(), timeLabel = '' } = {}) {
  const cols = Math.max(44, width)
  const barWidth = Math.max(36, cols - 4)
  const pad = '  '
  const time = fitText(timeLabel, Math.min(10, Math.max(0, barWidth - 16)))
  const textBudget = Math.max(12, barWidth - 8 - (time ? visibleLength(time) + 3 : 0))
  const parts = wrapWords(prompt, textBudget)
  return parts.map((part, index) => {
    const left = index === 0
      ? `${faint('  ')}${gradient('›')} ${text(bold(part))}`
      : `${faint('    ')}${text(bold(part))}`
    const right = index === 0 && time ? faint(time) : ''
    const gap = Math.max(1, barWidth - visibleLength(left) - visibleLength(right))
    return pad + surfaceBg(left + ' '.repeat(gap) + right, index)
  })
}

// The brand ramp the /cli hero uses: violet → sky → emerald.
const RAMP = [
  [0xa7, 0x8b, 0xfa],
  [0x38, 0xbd, 0xf8],
  [0x34, 0xd3, 0x99],
]

// Sample the ramp at t ∈ [0,1) — wraps around back to violet for animation.
function rampColor(t) {
  const stops = [...RAMP, RAMP[0]]
  const scaled = (t % 1) * (stops.length - 1)
  const i = Math.floor(scaled)
  const f = scaled - i
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f))
}

function paintRamp(s, offset = 0, spread = 1) {
  if (!brandEnabled) return String(s)
  const chars = [...s]
  const visible = chars.filter((c) => c.trim()).length
  let i = 0
  const fallback = [141, 75, 45, 48, 78, 141]
  return (
    chars
      .map((c) => {
        if (!c.trim()) return c
        const t = offset + (visible > 1 ? (i++ / (visible - 1)) * spread : 0)
        if (!truecolor) {
          const scaled = (((t % 1) + 1) % 1) * (fallback.length - 1)
          const index = Math.min(fallback.length - 2, Math.floor(scaled))
          return `\x1b[38;5;${fallback[index]}m${c}`
        }
        const [r, g, b] = rampColor(((t % 1) + 1) % 1)
        return `\x1b[38;2;${r};${g};${b}m${c}`
      })
      .join('') + '\x1b[39m'
  )
}

// per-character sky→emerald gradient, like the hero's pixel "terminal."
export function gradient(s) {
  if (!brandEnabled) return String(s)
  const from = RAMP[1]
  const to = RAMP[2]
  const chars = [...s]
  const visible = chars.filter((c) => c.trim()).length
  let i = 0
  return (
    chars
      .map((c) => {
        if (!c.trim()) return c
        const t = visible > 1 ? i++ / (visible - 1) : 0
        if (!truecolor) return `\x1b[38;5;${t < 0.5 ? 45 : 48}m${c}`
        const [r, g, b] = from.map((f, k) => Math.round(f + (to[k] - f) * t))
        return `\x1b[38;2;${r};${g};${b}m${c}`
      })
      .join('') + '\x1b[39m'
  )
}

// A horizontal rule with an optional plain-text label. `color` styles just the
// label (padding is computed from the plain text, so colored labels align).
// `glyph` is the little left cap that opens the rule.
export function rule(label = '', color = dim, glyph = '─') {
  const width = Math.min(terminalColumns(), 100)
  if (!label) return faint('─'.repeat(width))
  const seg = ` ${label} `
  const pad = Math.max(width - seg.length - 2, 0)
  return faint(glyph + '─') + color(seg) + faint('─'.repeat(pad))
}

function borderLine({ left, right, label = '', width, color = violet }) {
  const safeWidth = Math.max(18, width)
  const clean = fitText(label, safeWidth - 6)
  if (!clean) return faint(left + '─'.repeat(safeWidth - 2) + right)
  const tag = ` ${clean} `
  const rest = Math.max(0, safeWidth - visibleLength(tag) - 3)
  return faint(left + '─') + color(tag) + faint('─'.repeat(rest) + right)
}

export function panelLines({ title = '', subtitle = '', lines = [], footer = '', width = Math.min(terminalColumns(), 118), color = violet } = {}) {
  const safeWidth = Math.max(20, Math.min(width, Math.max(20, terminalColumns())))
  const inner = safeWidth - 4
  const label = [title, subtitle].filter(Boolean).join(' · ')
  const out = [borderLine({ left: '╭', right: '╮', label, width: safeWidth, color })]
  for (const raw of lines.length ? lines : ['']) {
    const text_ = String(raw ?? '')
    const parts = visibleLength(text_) > inner ? wrapWords(stripAnsi(text_), inner) : [text_]
    for (const part of parts) out.push(faint('│ ') + padVisible(part, inner) + faint(' │'))
  }
  out.push(borderLine({ left: '╰', right: '╯', label: footer, width: safeWidth, color: dim }))
  return out
}

function centerLine(value, width = terminalColumns()) {
  const size = visibleLength(value)
  return ' '.repeat(Math.max(0, Math.floor((width - size) / 2))) + value
}

function centeredBoxLine(content, width) {
  return faint('│') + padVisible(content, width - 2) + faint('│')
}

export function sliceVisible(value, width) {
  const input = String(value ?? '')
  const limit = Math.max(0, width)
  let out = ''
  let size = 0
  for (let i = 0; i < input.length && size < limit;) {
    if (input[i] === '\x1b') {
      const ansi = /^\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07)/.exec(input.slice(i))
      if (ansi) {
        out += ansi[0]
        i += ansi[0].length
        continue
      }
    }
    const char = [...input.slice(i)][0]
    if (size + terminalCellWidth(char) > limit) break
    out += char
    i += char.length
    size += terminalCellWidth(char)
  }
  if (/\x1b\[[0-9;?]*m/.test(out)) out += '\x1b[39m'
  return out
}

function overlayAt(row, text_, column, width) {
  const max = Math.max(0, width - column)
  const clean = visibleLength(text_) <= max ? String(text_) : fitText(text_, max)
  return padVisible(sliceVisible(row, column), column) + clean
}

function shortcutLine(label, shortcut, width) {
  const left = bold(label)
  const right = faint(shortcut)
  const gap = Math.max(1, width - 2 - visibleLength(left) - visibleLength(right))
  return left + ' '.repeat(gap) + right
}

function platformShortcut(key) {
  return process.platform === 'darwin' ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`
}

function compactInputStatus(status, width) {
  const budget = Math.max(8, width)
  const parts = stripAnsi(status).split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return ''
  const full = parts.join(' · ')
  if (visibleLength(full) <= budget) return full

  const model = parts.find((part) => /^model\b/i.test(part))
  const tail = parts.filter((part) => /^(ctx|input|output|total)\b/i.test(part))
  if (model && tail.length) {
    const tailText = tail.join(' · ')
    const name = model.replace(/^model\s+/i, '')
    const nameBudget = Math.max(8, budget - visibleLength(tailText) - 9)
    const compact = `model ${fitText(name, nameBudget, { middle: true })} · ${tailText}`
    if (visibleLength(compact) <= budget) return compact
  }

  const required = tail.filter((part) => /^(input|output|total)\b/i.test(part)).join(' · ')
  if (required && visibleLength(required) <= budget) return required
  return fitText(full, budget, { middle: true })
}

function inputStatusLine({ width, status, label }) {
  const safeWidth = Math.max(36, width)
  const inner = safeWidth - 4
  const labelValue = label && inner < 104 && /^Akorith CLI\b/.test(label) ? 'Akorith CLI' : label
  const labelBudget = Math.min(34, Math.max(8, Math.floor(inner * 0.26)))
  const labelText = labelValue ? faint(` ${fitText(labelValue, labelBudget, { middle: true })} `) : ''
  const statusBudget = Math.max(8, inner - visibleLength(labelText) - 1)
  const statusText = status ? dim(compactInputStatus(status, statusBudget)) : ''
  const gap = Math.max(1, inner - visibleLength(statusText) - visibleLength(labelText))
  return faint('│ ') + statusText + faint(' '.repeat(gap)) + labelText + faint(' │')
}

function akorithWordmarkFor(width) {
  return pixelLogoLines(width)
}

export function pixelLogoLines(width = terminalColumns(), maxRows = 6) {
  const available = Math.max(1, Number(width) || 80)
  if (available >= 58 && maxRows >= 6) {
    return WORDMARK.map((line, index) => paintRamp(line, index * 0.045, 0.55))
  }
  if (available >= 32 && maxRows >= 3) {
    return COMPACT_WORDMARK.map((line, index) => paintRamp(line, index * 0.08, 0.55))
  }
  return [gradient(bold('AKORITH'))]
}

export function grokInputPrompt({ width = terminalColumns() } = {}) {
  const inputWidth = Math.max(36, Math.min(126, width - 8))
  const left = Math.max(2, Math.floor((width - inputWidth) / 2))
  return `${' '.repeat(left)}${faint('╰─ ')}${gradient('›')} `
}

export function grokInputBoxLines({
  width = terminalColumns(),
  inputStatus = 'model default · ctx provider · input 0 · output 0 · total 0',
  label = 'Akorith CLI',
} = {}) {
  const inputWidth = Math.max(36, Math.min(126, width - 8))
  const inputLeft = Math.max(2, Math.floor((width - inputWidth) / 2))
  const inputPad = ' '.repeat(inputLeft)
  const lines = [
    inputPad + faint('╭' + '─'.repeat(inputWidth - 2) + '╮'),
    inputPad + inputStatusLine({
      width: inputWidth,
      status: inputStatus,
      label,
    }),
  ]
  return { lines, promptLine: lines.length }
}

export function grokSplashLines({
  version = '',
  tip = 'Use @! for hidden or ignored files: @!.github/workflows.',
  inputStatus = 'model default · ctx provider · input 0 · output 0 · total 0',
} = {}) {
  const cols = terminalColumns()
  const rows = terminalRows()
  const panelWidth = Math.max(56, Math.min(118, cols - 12))
  const panelLeft = Math.max(0, Math.floor((cols - panelWidth) / 2))
  const panelPad = ' '.repeat(panelLeft)
  const inner = panelWidth - 2
  const wordmark = akorithWordmarkFor(Math.min(58, inner - 48))
  const sideBySide = inner >= 104 && wordmark.length > 1
  const panelBodyRows = sideBySide ? 12 : 16
  const topPad = Math.max(2, Math.floor(rows * 0.18))
  const lines = []

  lines.push('')
  lines.push(faint('  ~'))
  while (lines.length < topPad) lines.push('')
  lines.push(panelPad + faint('╭' + '─'.repeat(panelWidth - 2) + '╮'))

  const body = Array(panelBodyRows).fill('').map(() => ' '.repeat(inner))
  if (sideBySide) {
    const artCol = 4
    const textCol = 62
    wordmark.forEach((line, index) => {
      if (index < body.length) body[index + 2] = overlayAt(body[index + 2], line, artCol, inner)
    })
    body[1] = overlayAt(body[1], `${bold('Akorith CLI')}  ${faint(version)}`, textCol, inner)
    body[3] = overlayAt(body[3], yellow(bold('Your agent workspace is ready.')), textCol, inner)
    body[4] = overlayAt(body[4], faint('Claude, Codex, and OpenCode in one responsive terminal.'), textCol, inner)
    body[7] = overlayAt(body[7], `${cyan('›')} ${bold('Start typing to begin')}`, textCol, inner)
    body[8] = overlayAt(body[8], faint('/help · /model · /sessions · /review'), textCol, inner)
    body[10] = overlayAt(body[10], shortcutLine('Quit', platformShortcut('q'), inner - textCol - 4), textCol, inner)
  } else {
    wordmark.forEach((line, index) => {
      body[index + 1] = centerLine(line, inner)
    })
    const textStart = Math.min(8, Math.max(2, Math.floor(inner * 0.12)))
    const offset = wordmark.length + 2
    body[offset] = overlayAt(body[offset], `${bold('Akorith CLI')}  ${faint(version)}`, textStart, inner)
    body[offset + 2] = overlayAt(body[offset + 2], yellow(bold('Your agent workspace is ready.')), textStart, inner)
    body[offset + 3] = overlayAt(body[offset + 3], faint('One responsive terminal for Claude, Codex, and OpenCode.'), textStart, inner)
    body[offset + 5] = overlayAt(body[offset + 5], `${cyan('›')} ${bold('Start typing to begin')}`, textStart, inner)
    body[offset + 6] = overlayAt(body[offset + 6], faint('/help · /model · /sessions · /review'), textStart, inner)
    body[offset + 8] = overlayAt(body[offset + 8], shortcutLine('Quit', platformShortcut('q'), inner - textStart - 2), textStart, inner)
  }
  for (const row of body) lines.push(panelPad + centeredBoxLine(row, panelWidth))
  lines.push(panelPad + faint('╰' + '─'.repeat(panelWidth - 2) + '╯'))

  const inputTop = Math.max(lines.length + 3, rows - 7)
  while (lines.length < inputTop - 2) lines.push('')
  lines.push(`${text(bold('Tip:'))} ${dim(fitText(tip, Math.max(20, cols - 8)))}`)
  lines.push('')

  const inputBox = grokInputBoxLines({ width: cols, inputStatus })
  lines.push(...inputBox.lines)
  while (lines.length < rows - 2) lines.push('')
  const promptLine = lines.length
  return { lines, promptLine }
}

const WORDMARK = [
  ' █████╗ ██╗  ██╗ ██████╗ ██████╗ ██╗████████╗██╗  ██╗',
  '██╔══██╗██║ ██╔╝██╔═══██╗██╔══██╗██║╚══██╔══╝██║  ██║',
  '███████║█████╔╝ ██║   ██║██████╔╝██║   ██║   ███████║',
  '██╔══██║██╔═██╗ ██║   ██║██╔══██╗██║   ██║   ██╔══██║',
  '██║  ██║██║  ██╗╚██████╔╝██║  ██║██║   ██║   ██║  ██║',
  '╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝',
]

const COMPACT_WORDMARK = [
  '▄▀▄ █▄▀ ▄▀▄ █▀▄ ▀█▀ ▀█▀ █ █',
  '█▀█ █ █ █ █ █▀▄  █   █  █▀█',
  '▀ ▀ ▀ ▀ ▀▄▀ ▀ ▀ ▀█▀  ▀  ▀ ▀',
]

function wordmarkFrame(offset) {
  // diagonal sweep: each row shifts the ramp slightly for a woven look
  return WORDMARK.map((row, r) => paintRamp(row, offset + r * 0.045, 0.55)).join('\n')
}

function taglines(version) {
  return [
    `${text(bold('Akorith'))} ${faint('v' + version)} — ${dim('the Agent OS for')} ${violet('your')} ${gradient('terminal.')}`,
    faint('One prompt for Claude, Codex, and OpenCode. No API keys — your CLIs, your machine.'),
  ].join('\n')
}

export function banner(version) {
  const cols = terminalColumns()
  const mark = cols >= 58 ? wordmarkFrame(0) : violet(bold('AKORITH'))
  return mark + '\n\n' + taglines(version)
}

// Startup animation: the wordmark's violet→sky→emerald ramp flows across the
// letters for ~2s, then settles. Skipped when not a truecolor TTY.
export async function animateBanner(version) {
  const cols = terminalColumns()
  if (!process.stdout.isTTY || !truecolor || cols < 58 || prefersReducedMotion()) {
    console.log(banner(version))
    return
  }
  process.stdout.write('\x1b[?25l') // hide cursor
  process.stdout.write(wordmarkFrame(0) + '\n')
  const frames = 36
  for (let f = 1; f <= frames; f++) {
    await new Promise((r) => setTimeout(r, 45))
    process.stdout.write(`\x1b[${WORDMARK.length}A\r` + wordmarkFrame(f / frames) + '\n')
  }
  process.stdout.write('\x1b[?25h') // show cursor
  console.log()
  console.log(taglines(version))
}

// Cursor tint to match the mock's violet caret. OSC 12 is widely supported
// (iTerm2, Terminal.app, kitty, wezterm); restore with resetCursor on exit.
export function tintCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b]12;#8b5cf6\x07')
}
export function resetCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b]112\x07')
}

// Live status line — stays up for the WHOLE turn. Output lines flow through
// spinner.log(), which lifts the status line, prints, and redraws it below,
// so the thinking pulse is always the last thing on screen.
// Smooth braille spinner for the leading glyph.
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function startSpinner(codename, display) {
  if (!process.stdout.isTTY && !terminalAdapter) {
    return { log: (line) => console.log(line), setStatus() {}, stop() {} }
  }
  const startedAt = Date.now()
  let tick = 0
  let stopped = false
  let status = 'thinking through the request'
  const compact = (value, max) => {
    const plain = stripAnsi(value)
    if (plain.length <= max) return value
    return plain.slice(0, Math.max(0, max - 1)) + '…'
  }
  const line = () => {
    const indent = '    '
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const [r, g, b] = rampColor((tick % 20) / 20)
    const glyph = `\x1b[38;2;${r};${g};${b}m${BRAILLE[tick % BRAILLE.length]}\x1b[39m`
    const meta = compact(`${status} · ${seconds}s`, Math.max(18, terminalColumns() - 18))
    return `${indent}${glyph} ${bold(gradient('Akorithing...'))}${faint(' · ' + meta)}`
  }
  if (terminalAdapter) {
    const adapter = terminalAdapter
    const draw = () => adapter.setSpinner(line())
    draw()
    const timer = prefersReducedMotion() ? null : setInterval(() => {
      if (stopped) return
      tick++
      draw()
    }, 110)
    timer?.unref?.()
    return {
      log(out) {
        adapter.append(out)
      },
      setStatus(next) {
        status = String(next || 'thinking through the request')
        draw()
      },
      stop() {
        stopped = true
        if (timer) clearInterval(timer)
        adapter.setSpinner('')
      },
    }
  }
  const draw = () => process.stdout.write('\r' + line() + '\x1b[K')
  const clear = () => process.stdout.write('\r\x1b[K')
  draw()
  const timer = prefersReducedMotion() ? null : setInterval(() => {
    if (stopped) return
    tick++
    draw()
  }, 110)
  timer?.unref?.()
  return {
    log(out) {
      if (stopped) return console.log(out)
      clear()
      process.stdout.write(out + '\n')
      draw()
    },
    setStatus(next) {
      status = String(next || 'thinking through the request')
      draw()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      clear()
    },
  }
}
