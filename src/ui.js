// Terminal styling helpers. Zero dependencies — plain ANSI.
// Palette mirrors the Akorith desktop app (src/renderer styles.css, dark theme).

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
export const inverse = wrap(7, 27)

// --accent / --text (near-white primary)
export const accent = fg('#ededf0', 255)
// --warning: the cream-gold that carries the Akorith brand warmth
export const gold = fg('#c9a85f', 179)
// --text-dim / --text-faint
export const dim = fg('#a0a0a8', 248)
export const faint = fg('#6f6f78', 242)
// status colors straight from the app
export const green = fg('#5fb37e', 72) // --success
export const red = fg('#df6f68', 167) // --danger
export const yellow = fg('#c9a85f', 179) // --warning
export const cyan = fg('#6fa3df', 110) // --info

export function rule(label = '') {
  const width = Math.min(process.stdout.columns || 80, 100)
  if (!label) return faint('─'.repeat(width))
  const text = ` ${label} `
  const pad = Math.max(width - text.length - 2, 0)
  return faint('──') + gold(text) + faint('─'.repeat(pad))
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
    for (const row of WORDMARK) lines.push(gold(row))
  } else {
    lines.push(gold(bold('AKORITH')))
  }
  lines.push('')
  lines.push(`${accent(bold('Akorith'))} ${faint('v' + version)} — ${dim('the Agent OS for your terminal')}`)
  lines.push(faint('One prompt for Claude, Codex, and OpenCode. No API keys — your CLIs, your machine.'))
  return lines.join('\n')
}

// Live status line: "✳ atlantis is thinking… 4s" in brand colors, until the
// provider produces its first byte. TTY-only; no-op when piped.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function startSpinner(subject) {
  if (!process.stdout.isTTY) return { stop() {} }
  const startedAt = Date.now()
  let frame = 0
  const render = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const verb = seconds < 8 ? 'thinking' : 'working'
    process.stdout.write(
      `\r${gold(FRAMES[frame++ % FRAMES.length])} ${accent(subject)} ${dim('is ' + verb + '…')} ${faint(seconds + 's')}\x1b[K`,
    )
  }
  render()
  const timer = setInterval(render, 90)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      process.stdout.write('\r\x1b[K')
    },
  }
}
