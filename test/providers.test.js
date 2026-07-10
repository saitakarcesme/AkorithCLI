import test from 'node:test'
import assert from 'node:assert/strict'
import { formatModel, parseModelSpec, PROVIDERS } from '../src/providers.js'

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
