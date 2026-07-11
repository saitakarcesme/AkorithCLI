import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildFrame } from '../src/terminal-screen.js'
import { visibleLength } from '../src/ui.js'

const matrixPath = fileURLToPath(new URL('./fixtures/viewport-matrix.txt', import.meta.url))
const viewports = readFileSync(matrixPath, 'utf8')
  .trim()
  .split(/\s+/)
  .map((value) => value.split('x').map(Number))

function assertFrame(frame, width, height) {
  assert.equal(frame.lines.length, height)
  assert.ok(frame.lines.every((line) => visibleLength(line) === width), `overflow at ${width}x${height}`)
  assert.ok(frame.cursorRow >= 1 && frame.cursorRow <= height)
  assert.ok(frame.cursorColumn >= 1 && frame.cursorColumn <= width)
}

test('viewport matrix keeps every UI state inside the terminal', () => {
  for (const [width, height] of viewports) {
    const common = {
      width,
      height,
      version: '0.1.0',
      model: 'opencode/a-very-long-provider-and-model-name',
      mode: 'act',
      cwd: '/workspace/a/deep/path/to/akorithcli',
      branch: 'codex/responsive-terminal-ui',
      dirty: true,
      session: 'Responsive terminal overhaul · #42',
      usage: '195,000 tokens',
      usageTotal: 195000,
      context: '200k',
    }
    assertFrame(buildFrame(common), width, height)
    assertFrame(buildFrame({
      ...common,
      input: 'Türkçe 🙂 界 multiline composer input that wraps without breaking its closed border\nsecond pasted line',
      cursor: 92,
      queue: 3,
    }), width, height)
    assertFrame(buildFrame({
      ...common,
      transcript: Array.from({ length: 120 }, (_, index) => `output ${index} · ${'content '.repeat(12)}`),
      spinner: '    Akorithing... · reading files',
    }), width, height)
    assertFrame(buildFrame({
      ...common,
      overlay: ['╭ Models ╮', ...Array.from({ length: 40 }, (_, index) => `${index === 31 ? '▸' : ' '} model ${index}`), '╰ enter selects ╯'],
    }), width, height)
  }
})
