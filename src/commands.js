import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatModel, runTurn } from './providers.js'
import {
  archiveSession, deleteSession, findSession, forkSession, listSessions,
} from './sessions.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(bin, args, options = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', ...options })
}

function commandExists(bin) {
  return run(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0
}

function versionOf(bin, args = ['--version']) {
  if (!commandExists(bin)) return null
  const result = run(bin, args)
  return result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : null
}

function gitOutput(args, cwd) {
  const result = run('git', args, { cwd })
  return result.status === 0 ? result.stdout.trim() : ''
}

function emitOutput(onOutput, value) {
  if (!value) return
  if (onOutput) onOutput(String(value).trimEnd())
  else console.log(String(value).trimEnd())
}

function runLogged(bin, args, { cwd, onOutput = null } = {}) {
  const result = onOutput
    ? spawnSync(bin, args, { cwd, encoding: 'utf8' })
    : spawnSync(bin, args, { cwd, stdio: 'inherit' })
  if (onOutput) {
    if (result.stdout) onOutput(result.stdout.trimEnd())
    if (result.stderr) onOutput(result.stderr.trimEnd())
  }
  return result.status ?? 1
}

function isGitRepo(cwd) {
  return run('git', ['rev-parse', '--is-inside-work-tree'], { cwd }).status === 0
}

function remoteDefaultBranch(cwd) {
  const head = gitOutput(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd)
  if (head.startsWith('origin/')) return head.slice('origin/'.length)
  for (const branch of ['main', 'master']) {
    if (run('git', ['show-ref', '--verify', `refs/remotes/origin/${branch}`], { cwd }).status === 0) return branch
  }
  return ''
}

function hasLocalBranch(cwd, branch) {
  return run('git', ['show-ref', '--verify', `refs/heads/${branch}`], { cwd }).status === 0
}

function updateLinkedRepo({ onOutput = null } = {}) {
  if (!commandExists('git') || !isGitRepo(ROOT)) return 0
  const dirty = gitOutput(['status', '--porcelain'], ROOT)
  if (dirty) {
    emitOutput(onOutput, 'Akorith update stopped: linked checkout has local changes.')
    emitOutput(onOutput, 'Commit/stash them or run npm install -g . manually if you want this exact local tree.')
    return 1
  }
  emitOutput(onOutput, 'Fetching latest Akorith from origin...')
  let code = runLogged('git', ['fetch', '--prune', 'origin'], { cwd: ROOT, onOutput })
  if (code !== 0) return code
  const branch = remoteDefaultBranch(ROOT)
  if (!branch) return 0
  const current = gitOutput(['branch', '--show-current'], ROOT)
  if (current !== branch) {
    const args = hasLocalBranch(ROOT, branch) ? ['switch', branch] : ['switch', '--track', `origin/${branch}`]
    code = runLogged('git', args, { cwd: ROOT, onOutput })
    if (code !== 0) return code
  }
  return runLogged('git', ['pull', '--ff-only', 'origin', branch], { cwd: ROOT, onOutput })
}

function truncate(value, max = 24000) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n\n[akorith: truncated ${value.length - max} chars]`
}

function fileMode(stat) {
  return (stat.mode & 0o111) ? '100755' : '100644'
}

function syntheticNewFilePatch(name, body, mode = '100644') {
  const lines = String(body).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return [
    `diff --git a/${name} b/${name}`,
    `new file mode ${mode}`,
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${name}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    ...(lines.length ? lines : ['']).map((line) => `+${line}`),
  ].join('\n')
}

function untrackedDiffs(cwd) {
  const names = gitOutput(['ls-files', '--others', '--exclude-standard'], cwd)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!names.length) return ''
  const chunks = []
  for (const name of names.slice(0, 20)) {
    const file = path.join(cwd, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > 80_000) {
        chunks.push(syntheticNewFilePatch(name, `[akorith: skipped ${stat.size} byte untracked file]`, fileMode(stat)))
        continue
      }
      const body = fs.readFileSync(file, 'utf8')
      if (body.includes('\u0000')) {
        chunks.push([
          `diff --git a/${name} b/${name}`,
          `new file mode ${fileMode(stat)}`,
          `Binary files /dev/null and b/${name} differ`,
        ].join('\n'))
        continue
      }
      chunks.push(syntheticNewFilePatch(name, body, fileMode(stat)))
    } catch {
      chunks.push(syntheticNewFilePatch(name, '[akorith: unable to read file]'))
    }
  }
  if (names.length > 20) {
    chunks.push(syntheticNewFilePatch('.akorith-untracked-summary', `[akorith: skipped ${names.length - 20} additional untracked files]`))
  }
  return chunks.join('\n\n')
}

export function buildReviewPatch({ cwd, base, commit, uncommitted }) {
  if (commit) return gitOutput(['show', '--stat', '--patch', '--find-renames', '--find-copies', commit], cwd)
  if (base) {
    const stat = gitOutput(['diff', '--stat', `${base}...HEAD`], cwd)
    const patch = gitOutput(['diff', '--find-renames', '--find-copies', `${base}...HEAD`], cwd)
    return [stat, patch].filter(Boolean).join('\n\n')
  }
  if (uncommitted) {
    const stat = gitOutput(['diff', '--stat'], cwd)
    const patch = gitOutput(['diff', '--find-renames', '--find-copies'], cwd)
    const staged = gitOutput(['diff', '--cached', '--find-renames', '--find-copies'], cwd)
    const untracked = untrackedDiffs(cwd)
    return [stat, patch, staged && `# Staged diff\n${staged}`, untracked]
      .filter(Boolean)
      .join('\n\n')
  }
  const stat = gitOutput(['diff', '--stat', 'HEAD'], cwd)
  const patch = gitOutput(['diff', '--find-renames', '--find-copies', 'HEAD'], cwd)
  return [stat, patch].filter(Boolean).join('\n\n')
}

export async function runReviewCommand({ selection, mode, cwd, options, review }, runOptions = {}) {
  const patch = review.patch || buildReviewPatch({ cwd, ...review })
  if (!patch) {
    console.error('No diff found to review.')
    return 1
  }
  const prompt = [
    'Review this code change. Focus on correctness, regressions, security, UX, and missing tests.',
    'Lead with findings ordered by severity. Keep summaries secondary.',
    review.title ? `Title: ${review.title}` : '',
    review.prompt ? `Extra instructions: ${review.prompt}` : '',
    '<diff>',
    truncate(patch),
    '</diff>',
  ].filter(Boolean).join('\n\n')
  return runTurn({ selection, prompt, resume: false, cwd, mode, options }, runOptions)
}

export function runDoctorCommand() {
  const checks = []
  const add = (name, ok, note = '') => checks.push({ name, ok, note })
  add('Node.js', Number(process.versions.node.split('.')[0]) >= 18, process.version)
  for (const bin of ['akorith', 'claude', 'codex', 'opencode', 'ollama', 'git', 'gh', 'npm']) {
    add(bin, commandExists(bin), versionOf(bin) || 'not found')
  }
  const globalRoot = run('npm', ['root', '-g']).stdout?.trim()
  const installed = globalRoot ? path.join(globalRoot, 'akorith') : ''
  const link = installed && fs.existsSync(installed) ? fs.realpathSync(installed) : ''
  add('global akorith link', link === ROOT, link || 'not installed globally from this repo')
  add('git repo', run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: process.cwd() }).status === 0, process.cwd())

  console.log('Akorith doctor')
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.name}${check.note ? ` — ${check.note}` : ''}`)
  }
  return checks.every((check) => check.ok || ['ollama', 'gh'].includes(check.name)) ? 0 : 1
}

export function runUpdateCommand({ local = false, onOutput = null } = {}) {
  const globalRoot = run('npm', ['root', '-g']).stdout?.trim()
  const installed = globalRoot ? path.join(globalRoot, 'akorith') : ''
  const linkedHere = installed && fs.existsSync(installed) && fs.realpathSync(installed) === ROOT
  if (!local && linkedHere) {
    const code = updateLinkedRepo({ onOutput })
    if (code !== 0) return code
  }
  const args = local || linkedHere ? ['install', '-g', '.'] : ['install', '-g', 'akorith']
  return runLogged('npm', args, { cwd: ROOT, onOutput })
}

export function printSessions({ all = false, cwd = null } = {}) {
  const sessions = listSessions({ all, cwd })
  if (!sessions.length) {
    console.log('No Akorith sessions yet.')
    return 0
  }
  for (const session of sessions) {
    const archived = session.archived ? ' archived' : ''
    const model = session.selection ? formatModel(session.selection) : 'unknown model'
    console.log(`${session.id}${archived} · ${model} · ${session.turns || 0} turns · ${session.name}`)
    console.log(`  ${session.cwd}`)
    if (session.lastPrompt) console.log(`  ${session.lastPrompt}`)
  }
  return 0
}

export function runSessionCommand(command, args = []) {
  if (command === 'sessions') return printSessions({ all: args.includes('--all') })
  const id = args.find((arg) => !arg.startsWith('-'))
  if (!id) {
    console.error(`Usage: akorith ${command} <session-id>`)
    return 1
  }
  const session = findSession(id)
  if (!session) {
    console.error(`Session not found: ${id}`)
    return 1
  }
  if (command === 'archive') archiveSession(session.id, true)
  else if (command === 'unarchive') archiveSession(session.id, false)
  else if (command === 'delete') deleteSession(session.id)
  else if (command === 'fork') {
    const forked = forkSession(session.id)
    console.log(`Forked ${session.id} -> ${forked.id}`)
    return 0
  }
  console.log(`${command}d ${session.id}`)
  return 0
}

export function runCodexPassthrough(args) {
  const result = spawnSync('codex', args, { stdio: 'inherit' })
  return result.status ?? 1
}
