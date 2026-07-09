import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFrame,
  composerLayout,
  fitScreenLine,
  headerLines,
  layoutTier,
  normalizeViewport,
  overlayWindow,
  TerminalScreen,
} from '../src/terminal-screen.js'
import { visibleLength } from '../src/ui.js'

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
  assert.ok(frame.lines.some((line) => line.includes('AKORITH')))
  assert.ok(frame.lines.some((line) => line.includes('typed inside the composer')))
  assert.ok(frame.lines.some((line) => line.includes('Your agent workspace is ready')))
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
  assert.ok(writes.some((value) => value.includes('\x1b[?1049l')))
})
