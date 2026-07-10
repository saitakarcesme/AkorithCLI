import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandHeaderLines, buildFrame } from '../src/terminal-screen.js'
import { stripAnsi } from '../src/ui.js'

const [outputArg = 'ui-test-screenshots/final-ui.svg', widthArg = '120', heightArg = '36', stateArg = 'splash'] = process.argv.slice(2)
const width = Math.max(20, Number(widthArg) || 120)
const height = Math.max(8, Number(heightArg) || 36)
const cellWidth = 9.15
const cellHeight = 20
const padding = 24
const chrome = 42
const svgWidth = Math.ceil(width * cellWidth + padding * 2)
const svgHeight = Math.ceil(height * cellHeight + padding * 2 + chrome)

const common = {
  width,
  height,
  version: '0.1.0',
  model: 'gaia · opencode/big-pickle',
  mode: 'act',
  cwd: '~/Desktop/akorithcli',
  branch: 'codex/responsive-terminal-ui',
  dirty: false,
  session: stateArg === 'splash' ? 'new session' : 'Responsive UI · #3',
  usage: '18,420 tokens',
  usageTotal: 18420,
  context: '200k',
}

const state = stateArg === 'typing'
  ? { input: 'Responsive composer keeps this text inside every border 🙂', cursor: 61 }
  : stateArg === 'busy'
    ? {
        busy: true,
        transcript: [
          '  ✓ succeeded in 0ms',
          '  › shell  npm --version',
          '  ✓ succeeded in 227ms',
          '    Implementation plan:',
          '    1. Keep every frame row anchored to its absolute terminal coordinate.',
          '    2. Preserve scrollback while provider output continues streaming.',
          '    3. Keep the wide sidebar divider continuous through the composer.',
          '  › shell  npm test',
          '  ✓ running responsive terminal checks',
        ],
        spinner: '    Akoriting···   olympus · 12s · running tests',
        todos: [
          { text: 'Anchor every frame row', done: true },
          { text: 'Preserve streaming scrollback', done: true },
          { text: 'Inspect divider continuity', active: true },
        ],
      }
  : stateArg === 'conversation'
    ? {
        transcript: [
          '  › Build a fully responsive terminal UI                                         10:42 PM',
          '',
          '  ◆ Thought · gaia · opencode/big-pickle',
          '',
          '    Header, transcript, overlays, and composer now share one atomic frame.',
          '    The composer stays pinned after output, resize, and session changes.',
          '    Turn completed in 4s.',
        ],
        todos: [
          { text: 'Normalize responsive layout', done: true },
          { text: 'Verify model switching', done: true },
          { text: 'Inspect final screenshots', active: true },
        ],
      }
    : {}

const frame = buildFrame({ ...common, ...state })
const brandRows = brandHeaderLines({ width, height }).length
const escapeXml = (value) => stripAnsi(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const textElement = (value, baseX, y, color) => {
  const leading = value.match(/^ */)?.[0].length || 0
  const content = value.slice(leading).replace(/\s+$/, '')
  if (!content) return ''
  return `<text x="${baseX + leading * cellWidth}" y="${y}" fill="${color}" xml:space="preserve">${escapeXml(content)}</text>`
}

const plainLines = frame.lines.map((line) => stripAnsi(line))
const sidebarColumn = frame.sidebarVisible
  ? plainLines.find((line) => line.includes('│ WORKSPACE'))?.indexOf('│ WORKSPACE') ?? -1
  : -1
const brandColors = ['#c4b5fd', '#a78bfa', '#818cf8', '#38bdf8', '#22d3ee', '#34d399']
const rows = plainLines.map((line, index) => {
  const y = chrome + padding + (index + 0.8) * cellHeight
  const color = index < brandRows ? brandColors[index % brandColors.length] : index < brandRows + 2 ? '#c4b5fd' : '#d4d4d8'
  if (sidebarColumn > 0) {
    const main = line.slice(0, sidebarColumn)
    const sidebar = line.slice(sidebarColumn)
    const sidebarX = padding + sidebarColumn * cellWidth
    return textElement(main, padding, y, color) + textElement(sidebar, sidebarX, y, '#a1a1aa')
  }
  return textElement(line, padding, y, color)
}).join('\n')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="${svgWidth}" height="${svgHeight}" rx="18" fill="#171719"/>
  <rect x="0" y="0" width="${svgWidth}" height="${chrome}" rx="18" fill="#252529"/>
  <rect x="0" y="${chrome - 18}" width="${svgWidth}" height="18" fill="#252529"/>
  <circle cx="24" cy="21" r="6" fill="#ff5f57"/>
  <circle cx="44" cy="21" r="6" fill="#febc2e"/>
  <circle cx="64" cy="21" r="6" fill="#28c840"/>
  <text x="88" y="27" fill="#a1a1aa" font-family="Menlo, Monaco, monospace" font-size="13">Akorith CLI · ${width}×${height}</text>
  <g font-family="Menlo, Monaco, 'Courier New', monospace" font-size="15" font-weight="500">${rows}</g>
</svg>\n`

writeFileSync(resolve(outputArg), svg)
