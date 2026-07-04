// Terminal styling helpers. Zero dependencies — plain ANSI.
// Palette mirrors the akorith.space /cli page terminal mock: white text at
// varying opacities on near-black, emerald-400 checkmarks, violet accents.

const enabled =
  process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '')

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
export const text = fg('#dcdde0', 255)
export const dim = fg('#85868c', 245)
export const faint = fg('#5c5d63', 240)
export const accent = text
// violet brand pair from the page (violet-400 text, violet-500 cursor)
export const violet = fg('#a78bfa', 141)
export const violetDeep = fg('#8b5cf6', 99)
// status colors as the page uses them (Tailwind 400s)
export const green = fg('#34d399', 42) // emerald-400 — the ✓ lines
export const red = fg('#f87171', 210)
export const yellow = fg('#fbbf24', 214)
export const cyan = fg('#38bdf8', 81) // sky-400 — hero gradient start

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
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
  if (!enabled || !truecolor) return violet(s)
  const chars = [...s]
  const visible = chars.filter((c) => c.trim()).length
  let i = 0
  return (
    chars
      .map((c) => {
        if (!c.trim()) return c
        const t = offset + (visible > 1 ? (i++ / (visible - 1)) * spread : 0)
        const [r, g, b] = rampColor(((t % 1) + 1) % 1)
        return `\x1b[38;2;${r};${g};${b}m${c}`
      })
      .join('') + '\x1b[39m'
  )
}

// per-character sky→emerald gradient, like the hero's pixel "terminal."
export function gradient(s) {
  if (!enabled || !truecolor) return cyan(s)
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
        const [r, g, b] = from.map((f, k) => Math.round(f + (to[k] - f) * t))
        return `\x1b[38;2;${r};${g};${b}m${c}`
      })
      .join('') + '\x1b[39m'
  )
}

export function rule(label = '') {
  const width = Math.min(process.stdout.columns || 80, 100)
  if (!label) return faint('─'.repeat(width))
  const label_ = ` ${label} `
  const pad = Math.max(width - label_.length - 2, 0)
  return faint('──') + dim(label_) + faint('─'.repeat(pad))
}

const WORDMARK = [
  ' █████╗ ██╗  ██╗ ██████╗ ██████╗ ██╗████████╗██╗  ██╗',
  '██╔══██╗██║ ██╔╝██╔═══██╗██╔══██╗██║╚══██╔══╝██║  ██║',
  '███████║█████╔╝ ██║   ██║██████╔╝██║   ██║   ███████║',
  '██╔══██║██╔═██╗ ██║   ██║██╔══██╗██║   ██║   ██╔══██║',
  '██║  ██║██║  ██╗╚██████╔╝██║  ██║██║   ██║   ██║  ██║',
  '╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝',
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
  const cols = process.stdout.columns || 80
  const mark = cols >= 58 ? wordmarkFrame(0) : violet(bold('AKORITH'))
  return mark + '\n\n' + taglines(version)
}

// Startup animation: the wordmark's violet→sky→emerald ramp flows across the
// letters for ~2s, then settles. Skipped when not a truecolor TTY.
export async function animateBanner(version) {
  const cols = process.stdout.columns || 80
  if (!process.stdout.isTTY || !truecolor || cols < 58) {
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
const ICONS = ['✦', '✧', '✶', '✺', '✹', '✷']

export function startSpinner(codename, display) {
  if (!process.stdout.isTTY) {
    return { log: (line) => console.log(line), stop() {} }
  }
  const startedAt = Date.now()
  let tick = 0
  let stopped = false
  const line = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const verb = seconds < 8 ? 'thinking' : 'working'
    const dots = ['', '.', '..', '…'][tick % 4]
    const [r, g, b] = rampColor((tick % 24) / 24)
    const icon = truecolor ? `\x1b[38;2;${r};${g};${b}m${ICONS[tick % ICONS.length]}\x1b[39m` : violet(ICONS[tick % ICONS.length])
    return `${icon} ${dim(`[${codename}] ${display} · ${verb}${dots}`)} ${faint(seconds + 's')}`
  }
  const draw = () => process.stdout.write('\r' + line() + '\x1b[K')
  const clear = () => process.stdout.write('\r\x1b[K')
  draw()
  const timer = setInterval(() => {
    if (stopped) return
    tick++
    draw()
  }, 120)
  timer.unref?.()
  return {
    log(out) {
      if (stopped) return console.log(out)
      clear()
      process.stdout.write(out + '\n')
      draw()
    },
    stop() {
      stopped = true
      clearInterval(timer)
      clear()
    },
  }
}
