import test from 'node:test'
import assert from 'node:assert/strict'
import {
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

