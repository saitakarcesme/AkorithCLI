import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFrame,
  composerLayout,
  fitScreenLine,
  headerLines,
  layoutTier,
  normalizeViewport,
} from '../src/terminal-screen.js'
import { visibleLength } from '../src/ui.js'

test('normalizes unusably small terminal dimensions', () => {
  assert.deepEqual(normalizeViewport(10, 2), { width: 32, height: 10 })
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
  assert.ok(layout.lines[0].startsWith('╭'))
  assert.ok(layout.lines[0].endsWith('╮'))
  assert.ok(layout.lines[1].startsWith('│ › hello Akorith'))
  assert.ok(layout.lines[1].endsWith('│'))
  assert.ok(layout.lines.some((line) => line.startsWith('╰') && line.endsWith('╯')))
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
  for (const [width, height] of [[32, 10], [40, 12], [52, 16], [63, 40]]) {
    const frame = buildFrame({
      width,
      height,
      model: 'opencode/very-long-model-name',
      cwd: '/deep/path/to/a/workspace',
      input: 'a long draft that must wrap while remaining inside the closed composer',
      cursor: 70,
      transcript: ['output ' + 'x'.repeat(200)],
    })
    assert.equal(frame.lines.length, Math.max(10, height))
    assert.ok(frame.lines.every((line) => visibleLength(line) === Math.max(32, width)))
  }
})
