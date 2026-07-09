import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const CONFIG_DIR = path.join(os.homedir(), '.akorith')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'cli.json')
export const SESSION_FILE = path.join(CONFIG_DIR, 'sessions.json')

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  try {
    ensureConfigDir()
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  } catch {
    // persistence is best-effort
  }
}

export function loadConfig() {
  return readJson(CONFIG_FILE, {})
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config)
}

export function nowIso() {
  return new Date().toISOString()
}

export function shortId(prefix = 'ak') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function homeRelative(value) {
  return String(value).replace(os.homedir(), '~')
}
