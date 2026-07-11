import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelSpec, shouldUseFullScreen } from '../src/repl.js'

const tty = { isTTY: true }

test('native terminal scrollback is the default interactive layout', () => {
  assert.equal(shouldUseFullScreen({ env: { TERM: 'xterm-256color' }, input: tty, output: tty }), false)
})

test('legacy full-screen layout requires an explicit opt in', () => {
  assert.equal(shouldUseFullScreen({ env: { TERM: 'xterm-256color', AKORITH_FULLSCREEN: '1' }, input: tty, output: tty }), true)
  assert.equal(shouldUseFullScreen({
    env: { TERM: 'xterm-256color', AKORITH_FULLSCREEN: '1', AKORITH_NO_FULLSCREEN: '1' },
    input: tty,
    output: tty,
  }), false)
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
