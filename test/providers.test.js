import test from 'node:test'
import assert from 'node:assert/strict'
import {
  codexErrorMessage,
  diffTextLines,
  formatModel,
  formatReasoningBlock,
  normalizeProviderMetadata,
  openCodeToolEventLines,
  parseOpenCodeEvent,
  parseModelSpec,
  parseCodexEvent,
  PROVIDERS,
} from '../src/providers.js'
import { stripAnsi } from '../src/ui.js'

test('Codex aliases become a valid model plus reasoning override', () => {
  const selection = parseModelSpec('codex/gpt-5.5-high')
  assert.deepEqual(selection, { provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' })
  const args = PROVIDERS.codex.args({ prompt: 'hello', ...selection, mode: 'view' })
  assert.ok(args.includes('gpt-5.5'))
  assert.ok(!args.includes('gpt-5.5-high'))
  assert.ok(args.includes('model_reasoning_effort="high"'))
})

test('Codex reasoning is visible in the current model label', () => {
  assert.equal(formatModel({ provider: 'codex', model: 'gpt-5.5-high' }), 'olympus · codex/gpt-5.5 · high')
})

test('Codex startup failures surface their API diagnostic', () => {
  const line = '2026-07-10T00:00:00Z ERROR codex_api: unexpected status 400 Bad Request: {"detail":"The requested model is not supported."}'
  assert.equal(codexErrorMessage(line), 'The requested model is not supported.')
  assert.equal(codexErrorMessage('ordinary preamble'), '')
})

test('Codex JSONL events are recognized without accepting ordinary text', () => {
  const event = parseCodexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')
  assert.equal(event.type, 'item.completed')
  assert.equal(event.item.text, 'done')
  assert.equal(parseCodexEvent('ordinary response'), null)
  assert.equal(parseCodexEvent('{not json}'), null)
})

test('live text diffs keep additions and deletions distinct and bounded', () => {
  const diff = diffTextLines('alpha\nbeta\ngamma\n', 'alpha\nupdated\ngamma\ndelta\n', { maxLines: 2 })
  assert.equal(diff.additions, 2)
  assert.equal(diff.deletions, 1)
  assert.deepEqual(diff.lines, [
    { type: 'del', text: 'beta' },
    { type: 'add', text: 'updated' },
  ])
  assert.equal(diff.truncated, 1)
})

test('provider reasoning is collected into one bounded block', () => {
  const block = formatReasoningBlock([
    'inspect files',
    'inspect files',
    'plan change',
    'edit code',
    'run tests',
    'check output',
  ], { width: 60, maxLines: 4 }).map(stripAnsi)
  assert.match(block[0], /Reasoning · 5 notes/)
  assert.ok(block.some((line) => line.includes('… 2 more reasoning lines')))
  assert.ok(block.every((line) => line.length <= 60))
})

test('provider metadata tags stay hidden and timeouts become compact tool cards', () => {
  assert.equal(normalizeProviderMetadata('<shell_metadata>').skip, true)
  assert.equal(normalizeProviderMetadata('</shell_metadata>').skip, true)
  const timeout = normalizeProviderMetadata('shell tool terminated command after exceeding timeout 10000 ms.')
  assert.equal(timeout.skip, false)
  assert.match(stripAnsi(timeout.line), /shell\s+✗\s+timed out after 10s/)
})

test('OpenCode runs are pinned to the Akorith working directory', () => {
  const args = PROVIDERS.opencode.args({
    prompt: 'build it',
    model: 'opencode/deepseek-v4-flash-free',
    cwd: '/tmp/isolated-project',
    mode: 'act',
  })
  assert.deepEqual(args.slice(-2), ['--auto', 'build it'])
  assert.ok(args.includes('--dir'))
  assert.equal(args[args.indexOf('--dir') + 1], '/tmp/isolated-project')
  assert.deepEqual(args.slice(args.indexOf('--format'), args.indexOf('--format') + 2), ['--format', 'json'])
  assert.equal(args.at(-1), 'build it')
})

test('OpenCode JSON tools become one compact card with summarized output', () => {
  const event = parseOpenCodeEvent(JSON.stringify({
    type: 'tool_use',
    part: {
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: { command: 'npm test' },
        output: ['TAP version 13', 'a noisy row', 'another row', 'tests 7', 'pass 7', 'fail 0', 'duration_ms 94'].join('\n'),
      },
    },
  }))
  const lines = openCodeToolEventLines(event, { width: 64 }).map(stripAnsi)
  assert.match(lines[0], /shell\s+✓\s+npm test/)
  assert.ok(lines.some((line) => line.includes('tests 7')))
  assert.ok(lines.some((line) => line.includes('fail 0')))
  assert.ok(!lines.some((line) => line.includes('a noisy row')))
})

test('malformed OpenCode output safely falls back to plain rendering', () => {
  assert.equal(parseOpenCodeEvent('{not json}'), null)
  assert.equal(parseOpenCodeEvent('ordinary output'), null)
})

test('OpenCode shell cards mark non-zero exits as errors', () => {
  const event = {
    type: 'tool_use',
    part: {
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: "sh -c 'exit 7'" },
        output: '(no output)',
        metadata: { exit: 7 },
      },
    },
  }
  const lines = openCodeToolEventLines(event, { width: 60 }).map(stripAnsi)
  assert.match(lines[0], /shell\s+✗/)
  assert.ok(lines.some((line) => line.includes('exit 7')))
  assert.ok(!lines.some((line) => line.includes('(no output)')))
})
