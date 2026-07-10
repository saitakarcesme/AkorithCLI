import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFrame,
  brandHeaderLines,
  compactComposerModel,
  composerLayout,
  contextUsageMeter,
  decodeTerminalMouseInput,
  extractPlanTodos,
  fitScreenLine,
  headerLines,
  layoutTier,
  normalizeViewport,
  overlayWindow,
  sidebarLines,
  terminalMouseEvent,
  TerminalScreen,
} from '../src/terminal-screen.js'
import { stripAnsi, visibleLength } from '../src/ui.js'

test('normalizes unusably small terminal dimensions', () => {
  assert.deepEqual(normalizeViewport(10, 2), { width: 20, height: 8 })
})

test('selects stable responsive layout tiers', () => {
  assert.equal(layoutTier(50, 30), 'compact')
  assert.equal(layoutTier(90, 24), 'regular')
  assert.equal(layoutTier(140, 40), 'wide')
})

test('persistent header never exceeds the viewport', () => {
  for (const width of [32, 40, 63, 64, 90, 112, 180]) {
    const lines = headerLines({
      width,
      height: 30,
      model: 'opencode/a-provider-with-a-very-long-model-identifier',
      cwd: '/a/very/deep/workspace/path/that/needs/middle/elision',
      branch: 'codex/responsive-terminal-ui',
      dirty: true,
      session: 'responsive terminal overhaul',
    })
    assert.ok(lines.every((line) => visibleLength(line) === Math.max(32, width)))
  }
})

test('composer keeps typed text inside a closed box', () => {
  const layout = composerLayout({ width: 80, height: 24, input: 'hello Akorith', cursor: 13 })
  assert.ok(layout.lines[0].trimStart().startsWith('╭'))
  assert.ok(layout.lines[0].trimEnd().endsWith('╮'))
  assert.ok(layout.lines[1].trimStart().startsWith('│ › hello Akorith'))
  assert.ok(layout.lines[1].trimEnd().endsWith('│'))
  assert.ok(layout.lines.some((line) => line.trimStart().startsWith('╰') && line.trimEnd().endsWith('╯')))
  assert.ok(layout.lines.every((line) => visibleLength(line) === 80))
})

test('narrow composer status drops duplicate provider branding', () => {
  assert.equal(compactComposerModel('olympus · codex/gpt-5.5 · high'), 'gpt-5.5 · high')
  assert.equal(compactComposerModel('gaia · opencode-go/glm-5.2'), 'glm-5.2')
})

test('composer scrolls multiline input to keep the cursor visible', () => {
  const input = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n')
  const layout = composerLayout({ width: 50, height: 14, input, cursor: input.length })
  assert.ok(layout.firstVisible > 0)
  assert.ok(layout.cursorRow > 0)
  assert.ok(layout.cursorRow < layout.lines.length - 2)
})

test('fitScreenLine returns exact-width rows', () => {
  assert.equal(visibleLength(fitScreenLine('hello', 48)), 48)
  assert.equal(visibleLength(fitScreenLine('x'.repeat(200), 48)), 48)
})

test('buildFrame reserves header, body, and bottom composer rows', () => {
  const frame = buildFrame({
    width: 96,
    height: 30,
    version: '0.1.0',
    model: 'codex/gpt-5.5',
    cwd: '/workspace/akorithcli',
    input: 'typed inside the composer',
    cursor: 25,
  })

  assert.equal(frame.lines.length, 30)
  assert.ok(frame.lines.every((line) => visibleLength(line) === 96))
  assert.ok(frame.lines.some((line) => line.includes('█████')))
  assert.ok(frame.lines.some((line) => line.includes('typed inside the composer')))
  assert.ok(frame.lines.some((line) => line.includes('workspace is ready')))
  assert.ok(frame.cursorRow > frame.bodyHeight)
  assert.ok(frame.cursorRow <= 30)
})

test('buildFrame keeps composer anchored after transcript growth', () => {
  const short = buildFrame({ width: 72, height: 22, input: 'draft', cursor: 5, transcript: ['one'] })
  const long = buildFrame({ width: 72, height: 22, input: 'draft', cursor: 5, transcript: Array.from({ length: 100 }, (_, index) => `line ${index}`) })

  assert.equal(short.cursorRow, long.cursorRow)
  assert.equal(short.cursorColumn, long.cursorColumn)
  assert.equal(short.lines.at(-4), long.lines.at(-4))
})

test('buildFrame reflows compact terminals without horizontal overflow', () => {
  for (const [width, height] of [[20, 8], [32, 10], [40, 12], [52, 16], [63, 40]]) {
    const frame = buildFrame({
      width,
      height,
      model: 'opencode/very-long-model-name',
      cwd: '/deep/path/to/a/workspace',
      input: 'a long draft that must wrap while remaining inside the closed composer',
      cursor: 70,
      transcript: ['output ' + 'x'.repeat(200)],
    })
    assert.equal(frame.lines.length, Math.max(8, height))
    assert.ok(frame.lines.every((line) => visibleLength(line) === Math.max(20, width)))
  }
})

test('overlay window keeps the selected row visible on short screens', () => {
  const lines = ['top', ...Array.from({ length: 20 }, (_, index) => `${index === 15 ? '▸' : ' '} row ${index}`), 'bottom']
  const visible = overlayWindow(lines, 8)
  assert.equal(visible.length, 8)
  assert.equal(visible[0], 'top')
  assert.equal(visible.at(-1), 'bottom')
  assert.ok(visible.some((line) => line.includes('▸ row 15')))
})

test('buildFrame can show older transcript rows without moving the composer', () => {
  const transcript = Array.from({ length: 40 }, (_, index) => `event ${index}`)
  const latest = buildFrame({ width: 70, height: 20, transcript, transcriptOffset: 0 })
  const older = buildFrame({ width: 70, height: 20, transcript, transcriptOffset: 20 })
  assert.ok(latest.lines.some((line) => line.includes('event 39')))
  assert.ok(older.lines.some((line) => line.includes('event 19')))
  assert.equal(latest.cursorRow, older.cursorRow)
})

test('terminal timeline can jump, search, and return to the tail', () => {
  const writes = []
  const output = { isTTY: true, columns: 60, rows: 18, write: (value) => writes.push(value) }
  const screen = new TerminalScreen({ output })
  screen.start()
  screen.append('alpha\nbeta target\ngamma')
  assert.equal(screen.searchTranscript('target'), 1)
  assert.equal(screen.transcriptOffset, 1)
  screen.jumpTo(0)
  assert.equal(screen.transcriptOffset, 2)
  screen.scroll(-99)
  assert.equal(screen.transcriptOffset, 0)
  assert.ok(screen.timelineLines().some((line) => line.includes('beta target')))
  screen.stop()
  assert.ok(writes.some((value) => value.includes('\x1b[?1049h')))
  assert.ok(writes.some((value) => value.includes('\x1b[?7l\x1b[?1000h\x1b[?1006h')))
  assert.ok(writes.some((value) => value.includes('\x1b[?6l\x1b[r')))
  assert.ok(writes.some((value) => value.includes('\x1b[1;1H')))
  assert.ok(writes.some((value) => value.includes('\x1b[?1006l\x1b[?1000l\x1b[?7h')))
  assert.ok(writes.some((value) => value.includes('\x1b[?1049l')))
})

test('scrollback remains pinned while new provider output arrives', () => {
  const screen = new TerminalScreen({ output: { isTTY: false } })
  screen.append(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'))
  screen.scroll(8)
  screen.append('new line one\nnew line two')
  assert.equal(screen.transcriptOffset, 10)
  assert.ok(screen.notice.includes('10 rows'))
  screen.scroll(-999)
  assert.equal(screen.transcriptOffset, 0)
})

test('parses SGR mouse wheel events without treating clicks as input', () => {
  assert.deepEqual(terminalMouseEvent('\x1b[<64;20;10M'), { type: 'wheel', direction: 'up', column: 20, row: 10 })
  assert.deepEqual(terminalMouseEvent('\x1b[<65;20;10M'), { type: 'wheel', direction: 'down', column: 20, row: 10 })
  assert.deepEqual(terminalMouseEvent('\x1b[<0;20;10M'), { type: 'mouse', direction: null, column: 20, row: 10 })
  assert.equal(terminalMouseEvent('ordinary input'), null)
})

test('reassembles mouse packets split by Node keypress events', () => {
  let decoded = decodeTerminalMouseInput('', '\x1b[<')
  assert.equal(decoded.captured, true)
  for (const chunk of ['6', '4', ';', '2', '0', ';', '1', '0']) {
    decoded = decodeTerminalMouseInput(decoded.buffer, chunk)
    assert.equal(decoded.event, null)
  }
  decoded = decodeTerminalMouseInput(decoded.buffer, 'M')
  assert.deepEqual(decoded.event, { type: 'wheel', direction: 'up', column: 20, row: 10 })
  assert.equal(decoded.buffer, '')
})

test('context usage meter reports thresholds without exceeding its width', () => {
  assert.equal(contextUsageMeter(0, '200k', 5), 'ctx [░░░░░] 0%')
  assert.equal(contextUsageMeter(100000, '200k', 5), 'ctx [███░░] 50%')
  assert.ok(contextUsageMeter(170000, '200k', 5).endsWith('%!'))
  assert.ok(contextUsageMeter(195000, '200k', 5).endsWith('%⚠'))
  assert.equal(contextUsageMeter(500, 'provider', 5), 'ctx provider')
})

test('large pixel logo remains in splash and conversation frames', () => {
  const splash = buildFrame({ width: 104, height: 32 })
  const conversation = buildFrame({ width: 104, height: 32, transcript: ['hello'] })
  assert.equal(brandHeaderLines({ width: 104, height: 32 }).length, 6)
  assert.ok(splash.lines.some((line) => line.includes('█████')))
  assert.ok(conversation.lines.some((line) => line.includes('█████')))
})

test('short transcript begins directly below the persistent header', () => {
  const frame = buildFrame({ width: 90, height: 30, transcript: ['first message', 'second message'] })
  const first = frame.lines.findIndex((line) => line.includes('first message'))
  const second = frame.lines.findIndex((line) => line.includes('second message'))
  assert.ok(first > 0)
  assert.equal(second, first + 1)
  assert.ok(first < Math.floor(frame.lines.length / 2))
})

test('wide layout moves metadata and todos into a right sidebar', () => {
  const todos = [
    { text: 'Fix model switching', done: true },
    { text: 'Add responsive sidebar', active: true },
  ]
  const wide = buildFrame({ width: 148, height: 40, model: 'codex/gpt-5.5 · high', todos })
  const regular = buildFrame({ width: 120, height: 40, model: 'codex/gpt-5.5 · high', todos })
  assert.equal(wide.sidebarVisible, true)
  assert.equal(regular.sidebarVisible, false)
  assert.ok(wide.lines.some((line) => line.includes('WORKSPACE')))
  assert.ok(wide.lines.some((line) => line.includes('Fix model switching')))
  assert.ok(!wide.lines.some((line) => line.includes('Enter send')))
  assert.ok(!regular.lines.some((line) => line.includes('Enter send')))
})

test('wide sidebar divider occupies the same column on every pane row', () => {
  const frame = buildFrame({
    width: 159,
    height: 46,
    transcript: Array.from({ length: 80 }, (_, index) => `streamed output ${index}`),
    spinner: '    Akoriting · running command',
  })
  const topRows = brandHeaderLines({ width: 159, height: 46 }).length + headerLines({ width: 159, height: 46 }).length + 1
  const dividerColumn = 159 - 38 - 1
  assert.ok(frame.lines.slice(topRows).every((line) => stripAnsi(line)[dividerColumn] === '│'))
})

test('full-screen paint addresses every row absolutely from the first row', () => {
  const writes = []
  const screen = new TerminalScreen({
    output: { isTTY: true, columns: 159, rows: 46, write: (value) => writes.push(value) },
  })
  screen.start()
  const paint = writes.find((value) => value.includes('\x1b[1;1H'))
  assert.ok(paint)
  assert.ok(paint.includes('█████'))
  assert.ok(!paint.includes('\n'))
  screen.stop()
})

test('sidebar rows always fit their assigned column', () => {
  const lines = sidebarLines({
    width: 34,
    height: 20,
    model: 'a/very-long-provider-model-name',
    todos: [{ text: 'A very long todo that needs elision' }],
  })
  assert.equal(lines.length, 20)
  assert.ok(lines.every((line) => visibleLength(line) === 34))
})

test('extracts checklist and named plan items for the sidebar', () => {
  assert.deepEqual(extractPlanTodos([
    'Plan:',
    '1. Inspect provider models',
    '2. Fix the responsive layout',
    '- [x] Add tests',
    '- [>] Capture screenshots',
    '✓ Add tests',
    '● Capture screenshots',
  ]), [
    { text: 'Inspect provider models', done: false, active: false },
    { text: 'Fix the responsive layout', done: false, active: false },
    { text: 'Add tests', done: true, active: false },
    { text: 'Capture screenshots', done: false, active: true },
  ])
})

test('does not treat ordinary success notices as plan tasks', () => {
  assert.deepEqual(extractPlanTodos([
    '✓ Now talking to olympus · codex/gpt-5.4 · high',
    '✓ Session saved',
  ]), [])
})
