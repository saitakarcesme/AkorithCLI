import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fitText, grokInputBoxLines, grokInputPrompt, grokSplashLines, panelLines,
  prefersReducedMotion, setTerminalAdapter, startSpinner, stripAnsi, userMessageLines, visibleLength, wrapWords,
} from '../src/ui.js'

test('wrapWords elides overlong tokens instead of splitting words', () => {
  const token = 'very-long-provider-model-name-with-a-deep/path/inside/the/workspace'
  const lines = wrapWords(`Use ${token} today`, 24)

  assert.ok(lines.every((line) => visibleLength(line) <= 24))
  assert.ok(lines.some((line) => line.includes('…')))
  assert.ok(!lines.some((line) => line === token.slice(0, 24)))
})

test('visible width accounts for emoji, CJK, and combining marks', () => {
  assert.equal(visibleLength('A🙂界'), 5)
  assert.equal(visibleLength('e\u0301'), 1)
  assert.equal(visibleLength('plain'), 5)
  assert.ok(visibleLength(fitText('🙂🙂🙂🙂', 5)) <= 5)
})

test('spinner renders through the full-screen adapter without raw cursor writes', () => {
  const events = []
  setTerminalAdapter({
    append: (line) => events.push(['line', stripAnsi(line)]),
    setSpinner: (line) => events.push(['spinner', stripAnsi(line)]),
  })
  const spinner = startSpinner('olympus', 'Codex')
  spinner.setStatus('reading files')
  spinner.log('provider output')
  spinner.stop()
  setTerminalAdapter(null)

  assert.ok(events.some(([kind, value]) => kind === 'spinner' && value.includes('akoriting')))
  assert.ok(events.some(([kind, value]) => kind === 'spinner' && value.includes('reading files')))
  assert.ok(events.some(([kind, value]) => kind === 'line' && value === 'provider output'))
  assert.deepEqual(events.at(-1), ['spinner', ''])
})

test('reduced motion preference is opt in through the environment', () => {
  const previous = process.env.AKORITH_REDUCED_MOTION
  process.env.AKORITH_REDUCED_MOTION = '1'
  assert.equal(prefersReducedMotion(), true)
  if (previous == null) delete process.env.AKORITH_REDUCED_MOTION
  else process.env.AKORITH_REDUCED_MOTION = previous
})

test('panelLines keeps every rendered row inside the requested width', () => {
  const lines = panelLines({
    title: 'Command palette',
    subtitle: 'responsive',
    lines: [
      `open ${fitText('a/very/deep/path/that/would/otherwise/overflow/the/terminal.js', 32, { middle: true })}`,
      'short row',
    ],
    footer: 'enter runs',
    width: 48,
  })

  assert.ok(lines.length >= 4)
  assert.ok(lines.every((line) => visibleLength(line) <= 48))
})

test('grokSplashLines renders a Grok Build-style splash inside terminal width', () => {
  process.env.COLUMNS = '134'
  process.env.LINES = '37'

  const prompt = grokInputPrompt({ width: 134 })
  const { lines, promptLine } = grokSplashLines({
    version: '0.1.0',
    inputStatus: 'olympus · codex/gpt-5-codex · ctx provider · input 0 · output 0 · total 0',
  })

  assert.ok(promptLine > 0)
  assert.equal(promptLine, lines.length)
  assert.ok(stripAnsi(prompt).trim().startsWith('╰─ ›'))
  assert.ok(lines.some((line) => line.includes('Akorith CLI Beta')))
  assert.ok(lines.some((line) => line.includes('New worktree')))
  assert.ok(lines.some((line) => stripAnsi(line).includes(process.platform === 'darwin' ? '⌘W' : 'Ctrl+W')))
  assert.ok(lines.some((line) => line.includes('Akorith Build · always-approve')))
  assert.ok(lines.some((line) => stripAnsi(line).includes('input 0')))
  assert.ok(lines.some((line) => stripAnsi(line).includes('output 0')))
  assert.ok(lines.some((line) => stripAnsi(line).includes('total 0')))
  assert.ok(lines.every((line) => visibleLength(line) <= 134))
})

test('grokInputBoxLines keeps metadata above the active readline prompt', () => {
  const box = grokInputBoxLines({
    width: 90,
    inputStatus: 'model opencode/big-pickle · ctx provider · input 1 · output 2 · total 3',
  })
  const prompt = grokInputPrompt({ width: 90 })

  assert.equal(box.promptLine, box.lines.length)
  assert.ok(stripAnsi(box.lines[0]).trim().startsWith('╭'))
  assert.ok(stripAnsi(box.lines[1]).includes('input 1'))
  assert.ok(stripAnsi(box.lines[1]).includes('Akorith Build'))
  assert.ok(stripAnsi(prompt).trim().startsWith('╰─ ›'))
  assert.ok(box.lines.every((line) => visibleLength(line) <= 90))
})

test('userMessageLines render Grok-style user bars inside terminal width', () => {
  const lines = userMessageLines({
    prompt: 'which model are you using for this Akorith terminal session right now',
    width: 90,
    timeLabel: '8:06 PM',
  })

  assert.ok(lines.length >= 1)
  assert.ok(stripAnsi(lines[0]).includes('›'))
  assert.ok(stripAnsi(lines[0]).includes('8:06 PM'))
  assert.ok(lines.every((line) => visibleLength(line) <= 90))
})
