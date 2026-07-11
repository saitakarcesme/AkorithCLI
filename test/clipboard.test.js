import test from 'node:test'
import assert from 'node:assert/strict'
import { copyToClipboard } from '../src/clipboard.js'

test('Windows clipboard receives content over stdin instead of command arguments', () => {
  const calls = []
  const result = copyToClipboard('hello\nworld', {
    platform: 'win32',
    runner(command, args, text) {
      calls.push({ command, args, text })
      return { status: 0, stderr: '' }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].text, 'hello\nworld')
  assert.ok(!calls[0].args.join(' ').includes('hello'))
})
