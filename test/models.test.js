import test from 'node:test'
import assert from 'node:assert/strict'
import { loadCodexModels, modelSelectionSpec, normalizeModelSelection } from '../src/models.js'

test('splits legacy Codex reasoning suffixes from the model slug', () => {
  assert.deepEqual(normalizeModelSelection({ provider: 'codex', model: 'gpt-5.5-high' }), {
    provider: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  })
  assert.equal(modelSelectionSpec({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' }), 'codex/gpt-5.5-high')
})

test('does not reinterpret non-Codex model names', () => {
  assert.deepEqual(normalizeModelSelection({ provider: 'claude', model: 'something-high' }), {
    provider: 'claude',
    model: 'something-high',
  })
})

test('loads visible Codex models and their supported reasoning efforts', () => {
  const readFile = () => JSON.stringify({
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        priority: 1,
        visibility: 'list',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
      },
      { slug: 'internal', display_name: 'Internal', priority: 0, visibility: 'hide' },
    ],
  })
  assert.deepEqual(loadCodexModels({ home: '/tmp/example', readFile }), [{
    slug: 'gpt-5.5',
    displayName: 'GPT-5.5',
    defaultReasoningEffort: 'medium',
    reasoningEfforts: ['medium', 'high'],
  }])
})
