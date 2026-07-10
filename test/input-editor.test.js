import test from 'node:test'
import assert from 'node:assert/strict'
import { InputEditor, ScreenInputAdapter } from '../src/input-editor.js'

test('edits Unicode input by visible code points', () => {
  const editor = new InputEditor()
  editor.insert('A🙂B')
  editor.handle('', { name: 'left' })
  editor.handle('', { name: 'backspace' })
  assert.equal(editor.value, 'AB')
  assert.equal(editor.cursor, 1)
})

test('keeps joined emoji and combining sequences atomic', () => {
  const editor = new InputEditor()
  editor.insert('e\u0301👨‍👩‍👧‍👦x')
  assert.equal(editor.cursor, 3)
  editor.deleteBackward()
  editor.deleteBackward()
  assert.equal(editor.value, 'e\u0301')
  assert.equal(editor.cursor, 1)
})

test('submits input and stores history', () => {
  const editor = new InputEditor()
  editor.insert('first prompt')
  assert.deepEqual(editor.handle('\r', { name: 'return' }), { type: 'submit', value: 'first prompt' })
  assert.equal(editor.value, '')
  editor.handle('', { name: 'up' })
  assert.equal(editor.value, 'first prompt')
})

test('restores the draft after history navigation', () => {
  const editor = new InputEditor()
  editor.setValue('one')
  editor.submit()
  editor.setValue('draft')
  editor.handle('', { name: 'up' })
  assert.equal(editor.value, 'one')
  editor.handle('', { name: 'down' })
  assert.equal(editor.value, 'draft')
})

test('supports multiline composer input', () => {
  const editor = new InputEditor()
  editor.insert('line one')
  editor.handle('\r', { name: 'return', shift: true })
  editor.insert('line two')
  assert.equal(editor.value, 'line one\nline two')
})

test('supports familiar readline editing shortcuts', () => {
  const editor = new InputEditor()
  editor.insert('alpha beta gamma')
  editor.handle('', { name: 'w', ctrl: true })
  assert.equal(editor.value, 'alpha beta ')
  editor.handle('', { name: 'a', ctrl: true })
  editor.handle('', { name: 'delete' })
  assert.equal(editor.value, 'lpha beta ')
  editor.handle('', { name: 'e', ctrl: true })
  editor.handle('', { name: 'u', ctrl: true })
  assert.equal(editor.value, '')
})

test('accepts bracketed paste chunks as one edit', () => {
  const editor = new InputEditor()
  const action = editor.handle('pasted\nblock', {})
  assert.equal(action.pasted, true)
  assert.equal(editor.value, 'pasted\nblock')
})

test('returns explicit global shortcut actions', () => {
  const editor = new InputEditor()
  assert.equal(editor.handle('', { name: 'p', ctrl: true }).type, 'palette')
  assert.equal(editor.handle('', { name: 'l', ctrl: true }).type, 'clear')
  assert.equal(editor.handle('', { name: 'c', ctrl: true }).type, 'interrupt')
  assert.equal(editor.handle('', { name: 'd', ctrl: true }).type, 'eof')
})

test('ctrl+d deletes forward when the draft is not empty', () => {
  const editor = new InputEditor()
  editor.setValue('abc', 1)
  assert.equal(editor.handle('', { name: 'd', ctrl: true }).type, 'change')
  assert.equal(editor.value, 'ac')
})

test('screen adapter preserves the readline contract used by the REPL', () => {
  let renders = 0
  const adapter = new ScreenInputAdapter({ render: () => renders++ })
  const submitted = []
  adapter.on('line', (line) => submitted.push(line))
  adapter.line = 'hello'
  adapter.cursor = 5
  adapter.submit(adapter.line)
  assert.deepEqual(submitted, ['hello'])
  assert.ok(renders >= 2)
})

test('screen adapter supports inline questions', () => {
  const adapter = new ScreenInputAdapter()
  let answer = null
  adapter.question('name', (value) => { answer = value })
  adapter.submit('renamed session')
  assert.equal(answer, 'renamed session')
  assert.equal(adapter.questionCallback, null)
})
