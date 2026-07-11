import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeSplashLines, parseOllamaList, resolveModelSpec, shouldUseFullScreen } from '../src/repl.js'
import { stripAnsi, visibleLength } from '../src/ui.js'

const tty = { isTTY: true }

test('responsive full-screen dashboard is the default interactive layout', () => {
  assert.equal(shouldUseFullScreen({ env: { TERM: 'xterm-256color' }, input: tty, output: tty }), true)
})

test('native scrollback fallback requires an explicit opt out', () => {
  assert.equal(shouldUseFullScreen({ env: { TERM: 'xterm-256color', AKORITH_FULLSCREEN: '1' }, input: tty, output: tty }), true)
  assert.equal(shouldUseFullScreen({
    env: { TERM: 'xterm-256color', AKORITH_NO_FULLSCREEN: '1' },
    input: tty,
    output: tty,
  }), false)
})

test('native splash is a scrollback-friendly welcome, not the old boxed dashboard copy', () => {
  const lines = nativeSplashLines({
    width: 90,
    cwd: '~/Desktop/akorithcli',
    model: 'gaia · opencode/deepseek-v4-flash-free',
    mode: 'act',
    tip: 'Use /timeline for transcript navigation',
  })
  const plain = lines.map(stripAnsi).join('\n')
  assert.match(plain, /Your agent workspace is ready\./)
  assert.match(plain, /Start typing to begin/)
  assert.match(plain, /\/help · \/model · \/sessions · \/review/)
  assert.doesNotMatch(plain, /Akorith Build is ready!/)
  assert.doesNotMatch(plain, /New worktree/)
  assert.doesNotMatch(plain, /always-approve/)
  assert.ok(lines.every((line) => visibleLength(line) <= 90))
})

test('interactive OpenCode model specs retain their full provider model id', () => {
  assert.deepEqual(resolveModelSpec('opencode/deepseek-v4-flash-free'), {
    provider: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
  })
  assert.deepEqual(resolveModelSpec('opencode-go/glm-5.2'), {
    provider: 'opencode',
    model: 'opencode-go/glm-5.2',
  })
})

test('parses local Ollama models from ollama list output', () => {
  assert.deepEqual(parseOllamaList(`
NAME                       ID              SIZE      MODIFIED
qwen3:latest               500a1f067a9f    5.2 GB    2 days ago
deepseek-r1:8b             28f8fd6cdc67    4.9 GB    3 weeks ago
qwen3:latest               500a1f067a9f    5.2 GB    2 days ago
`), ['qwen3:latest', 'deepseek-r1:8b'])
})

test('interactive Ollama choices resolve local model aliases', () => {
  const choices = [{
    label: 'Local · qwen3:latest',
    spec: 'ollama/qwen3:latest',
    visibleSpec: 'qwen3:latest',
    parsed: { provider: 'ollama', model: 'qwen3:latest' },
    aliases: ['qwen3:latest', 'qwen3'],
  }]
  assert.deepEqual(resolveModelSpec('qwen3', choices), {
    provider: 'ollama',
    model: 'qwen3:latest',
  })
})
