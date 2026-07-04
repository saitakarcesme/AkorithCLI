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

// per-character sky→emerald gradient, like the hero's pixel "terminal."
export function gradient(s) {
  if (!enabled || !truecolor) return cyan(s)
  const from = [0x38, 0xbd, 0xf8]
  const to = [0x34, 0xd3, 0x99]
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

export function banner(version) {
  const cols = process.stdout.columns || 80
  const lines = []
  if (cols >= 58) {
    for (const row of WORDMARK) lines.push(violet(row))
  } else {
    lines.push(violet(bold('AKORITH')))
  }
  lines.push('')
  lines.push(
    `${text(bold('Akorith'))} ${faint('v' + version)} — ${dim('the Agent OS for')} ${violet('your')} ${gradient('terminal.')}`,
  )
  lines.push(faint('One prompt for Claude, Codex, and OpenCode. No API keys — your CLIs, your machine.'))
  return lines.join('\n')
}

// Cursor tint to match the mock's violet caret. OSC 12 is widely supported
// (iTerm2, Terminal.app, kitty, wezterm); restore with resetCursor on exit.
export function tintCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b]12;#8b5cf6\x07')
}
export function resetCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b]112\x07')
}

// Live status line, exactly like the page mock: "[atlantis] Claude · planning…"
// in dim text with an animated ellipsis, until the provider's first byte.
// TTY-only; no-op when piped.
export function startSpinner(codename, display) {
  if (!process.stdout.isTTY) return { stop() {} }
  const startedAt = Date.now()
  let tick = 0
  const render = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const verb = seconds < 8 ? 'planning' : 'working'
    const dots = ['', '.', '..', '…'][tick++ % 4]
    process.stdout.write(
      `\r${dim(`[${codename}] ${display} · ${verb}${dots}`)} ${faint(seconds + 's')}\x1b[K`,
    )
  }
  render()
  const timer = setInterval(render, 280)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      process.stdout.write('\r\x1b[K')
    },
  }
}
