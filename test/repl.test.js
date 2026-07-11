import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeSplashLines, resolveModelSpec, shouldUseFullScreen } from '../src/repl.js'
import { stripAnsi, visibleLength } from '../src/ui.js'

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
