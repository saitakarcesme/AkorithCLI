import { EventEmitter } from 'node:events'
import { splitGraphemes } from './ui.js'

export class InputEditor {
  constructor({ historyLimit = 200, complete = null } = {}) {
    this.value = ''
    this.cursor = 0
    this.history = []
    this.historyLimit = historyLimit
    this.historyIndex = -1
    this.historyDraft = ''
    this.complete = complete
  }

  get line() {
    return this.value
  }

  set line(value) {
    this.value = String(value ?? '')
    this.cursor = Math.min(this.cursor, [...this.value].length)
  }

  chars() {
    return splitGraphemes(this.value)
  }

  setValue(value, cursor = null) {
    this.value = String(value ?? '')
    const length = this.chars().length
    this.cursor = cursor == null ? length : Math.max(0, Math.min(Number(cursor) || 0, length))
    this.historyIndex = -1
  }

  insert(value) {
    const chars = this.chars()
    const addition = splitGraphemes(value)
    chars.splice(this.cursor, 0, ...addition)
    this.value = chars.join('')
    this.cursor += addition.length
  }

  deleteBackward() {
    if (this.cursor <= 0) return
    const chars = this.chars()
    chars.splice(this.cursor - 1, 1)
    this.value = chars.join('')
    this.cursor--
  }

  deleteForward() {
    const chars = this.chars()
    if (this.cursor >= chars.length) return
    chars.splice(this.cursor, 1)
    this.value = chars.join('')
  }

  deleteWordBackward() {
    const chars = this.chars()
    let start = this.cursor
    while (start > 0 && /\s/.test(chars[start - 1])) start--
    while (start > 0 && !/\s/.test(chars[start - 1])) start--
    chars.splice(start, this.cursor - start)
    this.value = chars.join('')
    this.cursor = start
  }

  moveHistory(delta) {
    if (!this.history.length) return
    if (this.historyIndex === -1) this.historyDraft = this.value
    const next = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + delta))
    this.historyIndex = next
    this.value = next === -1 ? this.historyDraft : this.history[this.history.length - 1 - next]
    this.cursor = this.chars().length
  }

  remember(value) {
    const input = String(value ?? '')
    if (!input.trim()) return
    if (this.history.at(-1) !== input) this.history.push(input)
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit)
    this.historyIndex = -1
    this.historyDraft = ''
  }

  submit() {
    const value = this.value
    this.remember(value)
    this.setValue('')
    return { type: 'submit', value }
  }

  applyCompletion() {
    if (typeof this.complete !== 'function') return { type: 'bell' }
    const result = this.complete(this.value, this.cursor)
    if (!result) return { type: 'bell' }
    if (typeof result === 'string') {
      this.setValue(result)
      return { type: 'change' }
    }
    if (result.value != null) {
      this.setValue(result.value, result.cursor)
      return { type: 'change', candidates: result.candidates || [] }
    }
    return { type: 'bell', candidates: result.candidates || [] }
  }

  handle(str, key = {}) {
    if (key.ctrl && key.name === 'c') return { type: 'interrupt' }
    if (key.ctrl && key.name === 'd') {
      if (!this.value) return { type: 'eof' }
      this.deleteForward()
      return { type: 'change' }
    }
    if (key.ctrl && key.name === 'p') return { type: 'palette' }
    if (key.ctrl && key.name === 'l') return { type: 'clear' }
    if (key.ctrl && key.name === 'a') { this.cursor = 0; return { type: 'change' } }
    if (key.ctrl && key.name === 'e') { this.cursor = this.chars().length; return { type: 'change' } }
    if (key.ctrl && key.name === 'u') {
      const chars = this.chars()
      chars.splice(0, this.cursor)
      this.value = chars.join('')
      this.cursor = 0
      return { type: 'change' }
    }
    if (key.ctrl && key.name === 'k') {
      this.value = this.chars().slice(0, this.cursor).join('')
      return { type: 'change' }
    }
    if ((key.ctrl && key.name === 'w') || (key.meta && key.name === 'backspace')) {
      this.deleteWordBackward()
      return { type: 'change' }
    }
    if (str === '\n' || (key.ctrl && key.name === 'j')) { this.insert('\n'); return { type: 'change' } }
    if (key.name === 'return' || key.name === 'enter') {
      if (key.shift || key.meta) { this.insert('\n'); return { type: 'change' } }
      return this.submit()
    }
    if (key.name === 'backspace') { this.deleteBackward(); return { type: 'change' } }
    if (key.name === 'delete') { this.deleteForward(); return { type: 'change' } }
    if (key.name === 'left') { this.cursor = Math.max(0, this.cursor - 1); return { type: 'change' } }
    if (key.name === 'right') { this.cursor = Math.min(this.chars().length, this.cursor + 1); return { type: 'change' } }
    if (key.name === 'home') { this.cursor = 0; return { type: 'change' } }
    if (key.name === 'end') { this.cursor = this.chars().length; return { type: 'change' } }
    if (key.name === 'up' && !this.value.includes('\n')) { this.moveHistory(1); return { type: 'change' } }
    if (key.name === 'down' && !this.value.includes('\n')) { this.moveHistory(-1); return { type: 'change' } }
    if (key.name === 'tab') return this.applyCompletion()
    if (key.name === 'escape') return { type: 'escape' }
    if (str && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]$/.test(str)) {
      this.insert(str)
      return { type: 'change', pasted: [...str].length > 1 }
    }
    return { type: 'noop' }
  }
}

export class ScreenInputAdapter extends EventEmitter {
  constructor({ editor = new InputEditor(), render = () => {}, completer = null } = {}) {
    super()
    this.editor = editor
    this.render = render
    this.completer = completer
    this.promptText = ''
    this.questionCallback = null
    this.closed = false
  }

  get line() {
    return this.editor.value
  }

  set line(value) {
    this.editor.setValue(value, Math.min(this.editor.cursor, splitGraphemes(value).length))
    this.render()
  }

  get cursor() {
    return this.editor.cursor
  }

  set cursor(value) {
    this.editor.cursor = Math.max(0, Math.min(Number(value) || 0, this.editor.chars().length))
    this.render()
  }

  setPrompt(value) {
    this.promptText = String(value ?? '')
  }

  getPrompt() {
    return this.promptText
  }

  prompt() {
    this.render()
  }

  question(prompt, callback) {
    this.promptText = String(prompt ?? '')
    this.questionCallback = callback
    this.editor.setValue('')
    this.render()
  }

  handleKeypress(str, key) {
    return this.editor.handle(str, key)
  }

  submit(value) {
    if (this.questionCallback) {
      const callback = this.questionCallback
      this.questionCallback = null
      callback(value)
      this.render()
      return
    }
    this.emit('line', value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}
