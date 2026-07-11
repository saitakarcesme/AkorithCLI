import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

function commandLookup(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [bin], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function npmShimTarget(cmdPath) {
  try {
    if (/\\npm\.cmd$/i.test(cmdPath)) {
      const target = path.join(path.dirname(cmdPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (fs.existsSync(target)) return target
    }
    const body = fs.readFileSync(cmdPath, 'utf8')
    const match = body.match(/"([^"=]*\\node_modules\\[^"]+?\.js)"/i) ||
      body.match(/=[^\S\r\n]*([^="\r\n]*\\node_modules\\[^"\r\n]+?\.js)/i)
    if (!match) return null
    const target = match[1]
      .replace(/^%dp0%[\\/]/i, path.dirname(cmdPath) + path.sep)
      .replace(/^%~dp0[\\/]/i, path.dirname(cmdPath) + path.sep)
    return fs.existsSync(target) ? target : null
  } catch {
    return null
  }
}

export function resolveCommand(bin) {
  if (process.platform !== 'win32') return { command: bin, argsPrefix: [] }
  const paths = commandLookup(bin)
  for (const candidate of paths) {
    if (/\.cmd$/i.test(candidate)) {
      const target = npmShimTarget(candidate)
      if (target) return { command: process.execPath, argsPrefix: [target] }
    }
  }
  const executable = paths.find((candidate) => /\.exe$/i.test(candidate))
  if (executable) return { command: executable, argsPrefix: [] }
  return { command: bin, argsPrefix: [] }
}

export function commandExists(bin) {
  return commandLookup(bin).length > 0
}

export function runCommand(bin, args = [], options = {}) {
  const resolved = resolveCommand(bin)
  return spawnSync(resolved.command, [...resolved.argsPrefix, ...args], { encoding: 'utf8', ...options })
}
