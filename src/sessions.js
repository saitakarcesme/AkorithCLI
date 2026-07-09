import { SESSION_FILE, nowIso, readJson, shortId, writeJson } from './state.js'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'

function normalizeStore(store) {
  if (!store || !Array.isArray(store.sessions)) return { version: 1, sessions: [] }
  return { version: 1, sessions: store.sessions }
}

export function loadSessionStore() {
  return normalizeStore(readJson(SESSION_FILE, { version: 1, sessions: [] }))
}

export function saveSessionStore(store) {
  writeJson(SESSION_FILE, normalizeStore(store))
}

export function listSessions({ all = false, cwd = null } = {}) {
  const store = loadSessionStore()
  return store.sessions
    .filter((session) => all || !session.archived)
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function findSession(idOrName) {
  const value = String(idOrName || '').trim()
  if (!value) return null
  return loadSessionStore().sessions.find((session) =>
    session.id === value || session.name === value || session.id.startsWith(value)
  ) || null
}

export function createSession({ cwd, selection, mode, name = null, forkedFrom = null }) {
  const now = nowIso()
  const session = {
    id: shortId('ses'),
    name: name || `Session ${now.slice(0, 16).replace('T', ' ')}`,
    cwd,
    selection,
    mode,
    providerStarted: {},
    turns: 0,
    archived: false,
    forkedFrom,
    createdAt: now,
    updatedAt: now,
    lastPrompt: '',
  }
  const store = loadSessionStore()
  store.sessions.unshift(session)
  saveSessionStore(store)
  return session
}

export function touchSession(id, patch = {}) {
  const store = loadSessionStore()
  const index = store.sessions.findIndex((session) => session.id === id)
  if (index === -1) return null
  store.sessions[index] = { ...store.sessions[index], ...patch, updatedAt: nowIso() }
  saveSessionStore(store)
  return store.sessions[index]
}

export function recordTurn(id, { selection, mode, provider, prompt, code }) {
  const store = loadSessionStore()
  const index = store.sessions.findIndex((session) => session.id === id)
  if (index === -1) return null
  const current = store.sessions[index]
  const providerStarted = { ...(current.providerStarted || {}) }
  if (code === 0 && provider) providerStarted[provider] = true
  store.sessions[index] = {
    ...current,
    selection,
    mode,
    providerStarted,
    turns: (current.turns || 0) + 1,
    lastPrompt: String(prompt || '').slice(0, 240),
    updatedAt: nowIso(),
  }
  saveSessionStore(store)
  return store.sessions[index]
}

// Append a turn record to the in-memory transcript (`session.transcript[]`).
// Each record: { ts, role, provider, model, prompt, code, excerpt }.
// The excerpt is a short tail of the assistant output so the replay-on-resume
// view can show what happened without re-running the model. Capped to keep
// sessions.json from growing unbounded.
const MAX_TRANSCRIPT = 200
const EXCERPT_CHARS = 800

export function recordSessionTranscript(id, { provider, model, prompt, code, output = '' }) {
  const store = loadSessionStore()
  const index = store.sessions.findIndex((session) => session.id === id)
  if (index === -1) return null
  const current = store.sessions[index]
  const transcript = Array.isArray(current.transcript) ? current.transcript : []
  transcript.push({
    ts: nowIso(),
    role: 'user',
    provider,
    model: model || null,
    prompt: String(prompt || '').slice(0, 240),
    code: code ?? 0,
    excerpt: String(output).slice(-EXCERPT_CHARS),
  })
  while (transcript.length > MAX_TRANSCRIPT) transcript.shift()
  store.sessions[index] = { ...current, transcript, updatedAt: nowIso() }
  saveSessionStore(store)
  return store.sessions[index]
}

export function archiveSession(id, archived = true) {
  return touchSession(id, { archived })
}

export function deleteSession(id) {
  const store = loadSessionStore()
  const before = store.sessions.length
  store.sessions = store.sessions.filter((session) => session.id !== id)
  saveSessionStore(store)
  return store.sessions.length !== before
}

export function forkSession(id, overrides = {}) {
  const source = findSession(id)
  if (!source) return null
  return createSession({
    cwd: overrides.cwd || source.cwd,
    selection: overrides.selection || source.selection,
    mode: overrides.mode || source.mode,
    name: overrides.name || `${source.name || source.id} fork`,
    forkedFrom: source.id,
  })
}

export function renameSession(id, name) {
  return touchSession(id, { name: String(name || '').trim() || null })
}

export function exportSession(id, destPath) {
  const s = findSession(id)
  if (!s) return null
  const lines = []
  lines.push(`# Akorith session ${s.id}`)
  lines.push('')
  if (s.name) lines.push(`**${s.name}**`)
  lines.push(`- model: ${s.selection ? `${s.selection.provider}/${s.selection.model || 'default'}` : 'unknown'}`)
  lines.push(`- mode: ${s.mode || 'act'}`)
  lines.push(`- turns: ${s.turns || 0}`)
  lines.push(`- cwd: ${s.cwd || ''}`)
  lines.push(`- created: ${s.createdAt || ''}`)
  lines.push(`- updated: ${s.updatedAt || ''}`)
  if (s.archived) lines.push('- archived')
  if (s.forkedFrom) lines.push(`- forked from: ${s.forkedFrom}`)
  if (s.lastPrompt) {
    lines.push('')
    lines.push('## last prompt')
    lines.push('')
    lines.push(s.lastPrompt)
  }
  const body = lines.join('\n') + '\n'
  if (destPath) {
    try {
      const dir = dirname(destPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(destPath, body)
    } catch {}
  }
  return body
}
