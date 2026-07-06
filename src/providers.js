// Provider registry. Akorith drives locally installed agent CLIs — it never
// proxies traffic or stores credentials. Terminal names match the desktop app:
// Atlantis = Claude, Olympus = Codex, Gaia = OpenCode.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  startSpinner, stripAnsi, text as bright, dim, faint, green, red, violet, bold, diffAdd, diffDel,
} from './ui.js'

export const PROVIDERS = {
  claude: {
    id: 'claude',
    display: 'Claude',
    codename: 'Atlantis',
    bin: 'claude',
    hint: 'model aliases: opus, sonnet, haiku (e.g. /model claude/sonnet)',
    args({ prompt, model, resume, mode }) {
      const args = ['-p', prompt]
      if (model) args.push('--model', model)
      if (resume) args.push('-c')
      // plan mode is Claude Code's read-only session; acceptEdits lets it act
      args.push('--permission-mode', mode === 'act' ? 'acceptEdits' : 'plan')
      // In act mode, pre-approve the connected tools so "push this" runs
      // without a human at the approval prompt (headless -p can't answer one).
      if (mode === 'act') {
        const tools = allowedTools()
        if (tools.length) args.push('--allowedTools', ...tools)
      }
      return args
    },
  },
  codex: {
    id: 'codex',
    display: 'Codex',
    codename: 'Olympus',
    bin: 'codex',
    hint: 'pass any Codex model id (e.g. /model codex/gpt-5-codex)',
    args({ prompt, model, resume, mode }) {
      const args = resume ? ['exec', 'resume', '--last', prompt] : ['exec', prompt]
      args.push('--skip-git-repo-check')
      if (model) args.push('-m', model)
      // `resume` doesn't take -s, but both forms accept -c overrides
      const sandbox = mode === 'act' ? 'workspace-write' : 'read-only'
      args.push('-c', `sandbox_mode="${sandbox}"`)
      // Codex's workspace-write sandbox blocks the network by default, so
      // git push / gh / npm publish fail. Open it when a connection is on.
      if (mode === 'act' && connectionsOn()) {
        args.push('-c', 'sandbox_workspace_write.network_access=true')
      }
      return args
    },
  },
  opencode: {
    id: 'opencode',
    display: 'OpenCode',
    codename: 'Gaia',
    bin: 'opencode',
    hint: 'model format provider/model (e.g. /model opencode/anthropic/claude-sonnet-4-5)',
    args({ prompt, model, resume, mode }) {
      const args = ['run', prompt]
      if (model) args.push('-m', model)
      if (resume) args.push('-c')
      // OpenCode's built-in plan agent is its read-only mode
      if (mode === 'act') args.push('--auto')
      else args.push('--agent', 'plan')
      return args
    },
  },
  ollama: {
    id: 'ollama',
    display: 'Ollama',
    codename: 'Local',
    bin: 'ollama',
    hint: 'requires a running Ollama install (e.g. /model ollama/qwen3)',
    args({ prompt, model }) {
      return ['run', model || 'llama3.2', prompt]
    },
  },
}

// Connections: the external tools Akorith lets models drive in act mode.
// Each entry probes whether it's usable (installed + authenticated) and, when
// on, contributes pre-approved command patterns so a headless turn like
// "push this commit" runs end to end without a human approving each step.
export const CONNECTIONS = {
  git: {
    label: 'Git',
    detail: 'commit, branch, push, pull in the current repo',
    // Claude's tool-permission patterns; Codex uses its own network flag.
    claudeTools: ['Bash(git:*)'],
    needsNetwork: true,
    check() {
      const has = which('git')
      if (!has) return { ready: false, note: 'git not installed' }
      const name = run('git', ['config', 'user.name'])
      return {
        ready: true,
        note: name ? `as ${name}` : 'no user.name set — commits may be rejected',
      }
    },
  },
  github: {
    label: 'GitHub',
    detail: 'PRs, issues, releases, repo create/clone via gh',
    claudeTools: ['Bash(gh:*)'],
    needsNetwork: true,
    check() {
      if (!which('gh')) return { ready: false, note: 'gh CLI not installed' }
      const status = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
      const ok = status.status === 0
      const acct = (status.stdout + status.stderr).match(/account (\S+)/)
      return {
        ready: ok,
        note: ok ? `signed in${acct ? ' as ' + acct[1] : ''}` : 'run: gh auth login',
      }
    },
  },
  npm: {
    label: 'npm',
    detail: 'install, run scripts, publish packages',
    claudeTools: ['Bash(npm:*)', 'Bash(npx:*)'],
    needsNetwork: true,
    check() {
      if (!which('npm')) return { ready: false, note: 'npm not installed' }
      const who = run('npm', ['whoami'])
      return { ready: true, note: who ? `logged in as ${who}` : 'installed (not logged in — publish needs npm login)' }
    },
  },
}

function which(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0
}
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

const CONN_FILE = pathJoinHome('.akorith', 'connections.json')
function pathJoinHome(...parts) {
  return [homedir(), ...parts].join('/')
}
function homedir() {
  return process.env.HOME || process.env.USERPROFILE || '.'
}

// Which connections the user has switched on (default: all detected-ready).
export function loadConnections() {
  try {
    return JSON.parse(readFileSync(CONN_FILE, 'utf8'))
  } catch {
    return null // null = "not chosen yet" → treated as all-on for ready ones
  }
}
export function saveConnections(state) {
  try {
    mkdirSync(pathJoinHome('.akorith'), { recursive: true })
    writeFileSync(CONN_FILE, JSON.stringify(state, null, 2) + '\n')
  } catch {
    // best-effort
  }
}

// Snapshot for display and for arg-building: each connection with ready/on.
export function connectionStatus() {
  const chosen = loadConnections()
  const out = {}
  for (const [id, conn] of Object.entries(CONNECTIONS)) {
    const probe = conn.check()
    const on = chosen ? chosen[id] !== false : probe.ready
    out[id] = { ...conn, ...probe, on: on && probe.ready }
  }
  return out
}

export function connectionsOn() {
  return Object.values(connectionStatus()).some((c) => c.on && c.needsNetwork)
}

// Claude allowed-tool patterns for every connection currently on.
export function allowedTools() {
  const status = connectionStatus()
  const tools = []
  for (const [id, conn] of Object.entries(CONNECTIONS)) {
    if (status[id].on) tools.push(...conn.claudeTools)
  }
  return tools
}

export function detectProviders() {
  const found = {}
  for (const p of Object.values(PROVIDERS)) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [p.bin], {
      encoding: 'utf8',
    })
    found[p.id] = probe.status === 0
  }
  return found
}

// "claude/opus" -> { provider: claude, model: "opus" }; "codex" -> default model.
export function parseModelSpec(spec) {
  const [id, ...rest] = spec.trim().split('/')
  const provider = PROVIDERS[id]
  if (!provider) return null
  return { provider: provider.id, model: rest.join('/') || null }
}

// What each permission mode means, provider by provider.
export const MODES = {
  view: 'read-only — models can look but never write or execute',
  act: 'act — edits auto-approved, commands sandboxed to the workspace',
}

export function formatModel(selection) {
  const p = PROVIDERS[selection.provider]
  const model = selection.model || 'default'
  if (selection.provider === 'opencode' && selection.model) {
    return `${p.codename.toLowerCase()} · ${selection.model}`
  }
  return `${p.codename.toLowerCase()} · ${p.id}/${model}`
}

// Per-provider output renderers: turn the raw CLI streams into a quiet,
// readable feed. Every rendered line goes through print() (the spinner's log),
// so the animated status line stays pinned at the bottom for the whole turn.
function createRenderer(providerId, print, setStatus = () => {}) {
  if (providerId === 'codex') {
    // codex exec: stdout = final answer only; stderr = the full event log
    // (version/workdir preamble, `user` echo, `codex` messages, `exec` blocks,
    // `tokens used`). Render the interesting events, drop the boilerplate.
    let dashes = 0
    let block = 'suppress'
    let execHeader = false
    let patchOk = null // waiting for the patched file's path line
    let inDiff = false
    let spokeFromLog = false
    let lastBlank = true
    const flow = createFlowLinePrinter(print)
    const finalAnswer = []
    const shownDiff = new Set() // codex reprints the cumulative diff; show each line once
    const isDiffMeta = (plain) => /^(diff --git |index [0-9a-f]|new file mode |deleted file mode |--- |\+\+\+ )/.test(plain)
    const isDiffLine = (plain) =>
      isDiffMeta(plain) || /^@@ /.test(plain) || (inDiff && /^[+\- ]/.test(plain))
    // Render a diff line: '+' → green bar, '-' → purple bar, ' '/@@ → context.
    // Deduped so codex's repeated cumulative diffs don't stack up.
    const emitDiff = (plain) => {
      if (isDiffMeta(plain)) return
      if (shownDiff.has(plain)) return
      shownDiff.add(plain)
      if (/^@@ /.test(plain)) return void print(faint('  ' + plain))
      if (/^\+/.test(plain)) return void print(diffAdd(plain.slice(1)))
      if (/^-/.test(plain)) return void print(diffDel(plain.slice(1)))
      print(faint('  ' + plain.replace(/^ /, '')))
      lastBlank = false
    }
    const say = (line) => {
      const plain = stripAnsi(line).trimEnd()
      if (!plain) {
        inDiff = false
        if (!lastBlank) print('')
        lastBlank = true
        return
      }
      setStatus('writing response')
      // Show the code changes with colored backgrounds (deduped).
      if (isDiffLine(plain)) {
        inDiff = true
        lastBlank = false
        emitDiff(plain)
        return
      }
      lastBlank = false
      flow(line)
      spokeFromLog = true
    }
    return {
      stdoutLine(line) {
        finalAnswer.push(line)
      },
      stderrLine(line) {
        const plain = stripAnsi(line).trimEnd()
        if (dashes < 2) {
          if (/^-{4,}$/.test(plain.trim())) dashes++
          return
        }
        if (plain === 'user') return void ((block = 'suppress'), setStatus('reading prompt'))
        if (plain === 'codex') return void ((block = 'say'), (inDiff = false), setStatus('writing response'))
        if (plain === 'thinking') return void ((block = 'think'), setStatus('thinking through the request'))
        if (plain === 'exec') return void ((block = 'exec'), (execHeader = true), setStatus('running command'))
        if (plain === 'apply patch') return void ((block = 'patch'), (patchOk = null), setStatus('editing files'))
        if (plain === 'tokens used') return void ((block = 'tokens'), setStatus('wrapping up'))
        if (block === 'say') say(line)
        else if (block === 'think') {
          // Keep the live spinner as the thinking indicator; the internal
          // reasoning stream is too noisy for the Akorith transcript.
        }
        else if (block === 'exec') {
          if (execHeader) {
            execHeader = false
            const m = plain.match(/-l?c '([\s\S]+)' in /)
            const cmd = m ? m[1] : plain.replace(/ in \/.*$/, '')
            setStatus('running ' + compactCommand(cmd, 42))
            print(violet('  › ') + dim(compactCommand(cmd)))
            lastBlank = false
          } else if (/succeeded in \S+:?\s*$/.test(plain)) {
            print(green('    ✓ ') + faint(plain.trim().replace(/:$/, '')))
          } else if (/(failed|exited \d+) in \S+:?\s*$/.test(plain)) {
            print(red('    ✗ ') + faint(plain.trim().replace(/:$/, '')))
          }
          // command output itself stays quiet — codex narrates what matters
        } else if (block === 'patch') {
          if (/^patch: /.test(plain)) {
            patchOk = /^patch: (completed|applied|success)/.test(plain)
          } else if (/^(diff --git|index [0-9a-f]|new file|deleted file|--- |\+\+\+ |@@ |[+\- ])/.test(plain)) {
            // the actual code change — render it as green/purple diff bars
            inDiff = true
            emitDiff(plain)
          } else if (patchOk !== null && plain) {
            // the patched file's path line (before the diff body)
            const file = plain.split('/').pop()
            const mark = patchOk ? green(' ✓') : red(' ✗')
            print(violet('  › ') + dim('edit ' + file) + mark)
            lastBlank = false
            patchOk = null
          }
        } else if (block === 'tokens' && plain) {
          // Token accounting is useful for logs, but noisy in the live terminal.
          block = 'suppress'
        }
      },
      flush() {
        // stderr log went missing (future codex versions?) — fall back to stdout
        if (!spokeFromLog && finalAnswer.some((l) => stripAnsi(l).trim())) {
          for (const line of finalAnswer) flow(line)
        }
      },
    }
  }

  if (providerId === 'opencode') {
    // Drop runtime boilerplate, then normalize shell transcripts, markdown
    // fences, todos, and diffs into the same compact Akorith flow.
    let started = false
    const emit = createFlowLinePrinter(print, { suppressRuntimeBanner: true })
    const route = (line) => {
      const plain = stripAnsi(line).trim()
      if (/^\$\s+/.test(plain)) setStatus('running command')
      else if (/^[-–—]>|^→|^➜/.test(plain)) setStatus('reading context')
      else if (plain) setStatus('writing response')
      if (!started) {
        if (!plain || /^>\s*(build|run)\b/i.test(plain)) return
        started = true
      }
      emit(line)
    }
    return { stdoutLine: route, stderrLine: route, flush() {} }
  }

  // claude / ollama: answer arrives on stdout as-is (diff regions get colored)
  const emit = createFlowLinePrinter(print)
  return {
    stdoutLine(line) {
      if (stripAnsi(line).trim()) setStatus('writing response')
      emit(line)
    },
    stderrLine(line) {
      const plain = stripAnsi(line).trim()
      if (plain) {
        setStatus('processing provider output')
        print(dim(plain))
      }
    },
    flush() {},
  }
}

function createFlowLinePrinter(print, { suppressRuntimeBanner = false } = {}) {
  let lastBlank = true
  let suppressListingOutput = false
  const emitPlain = (line) => {
    const plain = stripAnsi(line).trim()
    if (!plain) {
      if (!lastBlank) print('')
      lastBlank = true
      return
    }
    print(line)
    lastBlank = false
  }
  const emitDiffAware = diffAwareLine(emitPlain)

  return (line) => {
    const plain = stripAnsi(line).trimEnd()
    const trimmed = plain.trim()

    if (!trimmed) return emitPlain('')
    if (/^```/.test(trimmed)) return
    if (/^\(no output\)$/i.test(trimmed)) return

    if (suppressListingOutput) {
      if (trimmed === 'done' || isListingHeaderLine(trimmed) || isListingOutputLine(trimmed)) return
      suppressListingOutput = false
    }

    if (/^>\s*/.test(trimmed)) {
      if (suppressRuntimeBanner && /^>\s*(build|run)\b/i.test(trimmed)) return
      return emitPlain(faint('  · ' + trimmed.replace(/^>\s*/, '')))
    }

    const shell = trimmed.match(/^\$\s+(.+)$/)
    if (shell) {
      suppressListingOutput = /\bls\s+-/.test(shell[1]) || /^ls(\s|$)/.test(shell[1])
      return emitPlain(violet('  › ') + dim(compactCommand(shell[1])))
    }

    const done = trimmed.match(/^Done\.?\s*(.*)$/i)
    if (done) return emitPlain(green('  ✓ ') + bright(done[1] || 'done'))

    const arrow = trimmed.match(/^(?:[-–—]>|→|➜)\s+(.+)/)
    if (arrow) return emitPlain(violet('  › ') + dim(arrow[1]))

    const mdHeading = trimmed.match(/^#{1,3}\s+(.+)/)
    if (mdHeading) return emitPlain(violet('  ' + bold(mdHeading[1].replace(/:$/, ''))))

    const checked = trimmed.match(/^\[(?:x|✓|✔)\]\s+(.+)/i)
    if (checked) return emitPlain(green('  ✓ ') + dim(checked[1]))

    const active = trimmed.match(/^\[(?:•|\*|\.|…|-)\]\s+(.+)/)
    if (active) return emitPlain(violet('  ◐ ') + dim(active[1]))

    const unchecked = trimmed.match(/^\[\s\]\s+(.+)/)
    if (unchecked) return emitPlain(faint('  ○ ' + unchecked[1]))

    const heading = trimmed.match(/^\*\*(.+?)\*\*:?\s*$/)
    if (heading) return emitPlain(violet('  ' + bold(heading[1].replace(/:$/, ''))))

    const bullet = trimmed.match(/^[-*]\s+(.+)/)
    if (bullet) return emitWrappedBullet(bullet[1], emitPlain)

    if (isPlainAnalysisLine(trimmed)) return emitWrappedParagraph(trimmed, emitPlain)

    emitDiffAware(line)
  }
}

function terminalWidth() {
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 88)
  return Math.max(52, Math.min(Number.isFinite(columns) ? columns : 88, 110))
}

function emitWrappedParagraph(line, emit) {
  const text = cleanMarkdownText(line)
  for (const part of wrapText(text, terminalWidth())) emit(bright(part))
}

function emitWrappedBullet(line, emit) {
  const parts = wrapText(cleanMarkdownText(line), terminalWidth() - 4)
  parts.forEach((part, i) => {
    const prefix = i === 0 ? violet('  • ') : faint('    ')
    emit(prefix + dim(part))
  })
}

function wrapText(text, width) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let line = ''
  for (const word of words) {
    if (!line) {
      line = word
    } else if (stripAnsi(line).length + 1 + word.length <= width) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function cleanMarkdownText(line) {
  return line
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+([,.;:])/g, '$1')
}

function isPlainAnalysisLine(line) {
  return (
    line.length > terminalWidth() - 12 ||
    /\*\*|`[^`]+`/.test(line) ||
    /[.!?:]\s*$/.test(line)
  )
}

function isListingHeaderLine(line) {
  return /^===\s+.+\s+===$/.test(line)
}

function isListingOutputLine(line) {
  return (
    /^total\s+\d+/.test(line) ||
    /^[bcdlps-][rwx-]{9}[@+ ]?\s+\d+\s+/.test(line) ||
    /^\d+\s+/.test(line)
  )
}

function compactCommand(command, max = 110) {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  if (max <= 18) return oneLine.slice(0, max)
  const head = Math.max(8, Math.floor(max * 0.68))
  const tail = Math.max(6, max - head - 5)
  return `${oneLine.slice(0, head)} ... ${oneLine.slice(-tail)}`
}

// Print raw provider output, but colorize unified-diff regions: once a real
// diff header (`diff --git` / `@@ -x +y @@`) is seen, '+' lines get an
// Akorith-green background and '-' lines an Akorith-purple background until a
// blank/non-diff line. Guarded by the header so ordinary markdown ("- item")
// is never touched.
function diffAwareLine(print) {
  let inRegion = false
  return (line) => {
    const t = stripAnsi(line).replace(/\s+$/, '')
    if (/^diff --git /.test(t) || /^@@ -\d+.*@@/.test(t)) inRegion = true
    if (inRegion) {
      if (/^(diff --git|index [0-9a-f]|new file|deleted file|--- |\+\+\+ )/.test(t)) return
      if (/^@@ /.test(t)) return void print(faint('  ' + t))
      if (/^\+/.test(t)) return void print(diffAdd(t.slice(1)))
      if (/^-/.test(t)) return void print(diffDel(t.slice(1)))
      if (t === '') {
        inRegion = false
        return void print('')
      }
      if (/^ /.test(t)) return void print(faint('  ' + t.replace(/^ /, '')))
      inRegion = false // anything else ends the diff region
    }
    print(line)
  }
}

function lineSplitter(onLine) {
  let buf = ''
  return {
    push(chunk) {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, idx).replace(/\r$/, ''))
        buf = buf.slice(idx + 1)
      }
    },
    end() {
      if (buf) onLine(buf)
      buf = ''
    },
  }
}

// Runs one turn against the selected provider. The animated status line stays
// alive for the entire turn — rendered output lines flow in above it via the
// renderer. Resolves with the exit code; Ctrl+C kills only the child.
// FORCE_COLOR/CLICOLOR_FORCE keep the providers' own colors despite the pipe.
export function runTurn({ selection, prompt, resume, cwd, mode = 'act' }, { onSpawn } = {}) {
  const provider = PROVIDERS[selection.provider]
  const args = provider.args({ prompt, model: selection.model, resume, mode })
  return new Promise((resolve) => {
    const child = spawn(provider.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
    })
    onSpawn?.(child)

    const spinner = startSpinner(provider.codename.toLowerCase(), provider.display)
    const renderer = createRenderer(provider.id, (line) => spinner.log(line), (status) => spinner.setStatus(status))
    const out = lineSplitter((l) => renderer.stdoutLine(l))
    const err = lineSplitter((l) => renderer.stderrLine(l))
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))

    const wrapUp = () => {
      out.end()
      err.end()
      renderer.flush()
      spinner.stop()
    }
    child.on('error', (err_) => {
      wrapUp()
      if (err_.code === 'ENOENT') {
        console.error(`\n${provider.bin}: not installed — install it to use this provider.`)
      } else {
        console.error(`\n${provider.bin}: ${err_.message}`)
      }
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      // stdio streams may still be draining when exit fires
      setTimeout(() => {
        wrapUp()
        resolve(signal ? 130 : code ?? 0)
      }, 60)
    })
  })
}
