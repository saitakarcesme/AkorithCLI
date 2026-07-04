// Terminal styling helpers. Zero dependencies — plain ANSI.

const enabled = process.stdout.isTTY && process.env.NO_COLOR === undefined
const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s))

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const italic = wrap(3, 23)
export const inverse = wrap(7, 27)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const cyan = wrap(36, 39)
// Akorith cream/tan accent (256-color 180, falls back fine on 16-color terms)
export const accent = enabled ? (s) => `\x1b[38;5;180m${s}\x1b[39m` : (s) => String(s)

export function rule(label = '') {
  const width = Math.min(process.stdout.columns || 80, 100)
  if (!label) return dim('─'.repeat(width))
  const text = ` ${label} `
  const pad = Math.max(width - text.length - 2, 0)
  return dim('──' + text + '─'.repeat(pad))
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
    for (const row of WORDMARK) lines.push(accent(row))
  } else {
    lines.push(accent(bold('AKORITH')))
  }
  lines.push('')
  lines.push(`${bold('Akorith')} ${dim('v' + version)} — ${dim('the Agent OS for your terminal')}`)
  lines.push(dim('One prompt for Claude, Codex, and OpenCode. No API keys — your CLIs, your machine.'))
  return lines.join('\n')
}
