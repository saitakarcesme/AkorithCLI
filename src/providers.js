// Provider registry. Akorith drives locally installed agent CLIs — it never
// proxies traffic or stores credentials. Terminal names match the desktop app:
// Atlantis = Claude, Olympus = Codex, Gaia = OpenCode.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  startSpinner, stripAnsi, text as bright, dim, faint, green, red, violet, bold, diffAdd, diffDel,
  fitText, terminalColumns, wrapWords,
} from './ui.js'
import { highlight, normalizeLang } from './highlight.js'
import { toolCardHeader, toolCardBody } from './toolcard.js'
import { normalizeModelSelection } from './models.js'
import { commandExists, resolveCommand, runCommand } from './runtime.js'

export const PROVIDERS = {
  claude: {
    id: 'claude',
    display: 'Claude',
    codename: 'Atlantis',
    bin: 'claude',
    hint: 'model aliases: opus, sonnet, haiku (e.g. /model claude/sonnet)',
    args({ prompt, model, resume, mode, options = {} }) {
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
      for (const dir of options.addDirs || []) args.push('--add-dir', dir)
      if (options.json) args.push('--output-format', 'json')
      if (options.outputSchema) args.push('--json-schema', options.outputSchema)
      return args
    },
  },
  codex: {
    id: 'codex',
    display: 'Codex',
    codename: 'Olympus',
    bin: 'codex',
    hint: 'models come from your Codex install (e.g. /model codex/gpt-5.5-high)',
    args({ prompt, model, reasoningEffort, resume, mode, options = {} }) {
      const args = resume ? ['exec', 'resume', '--last'] : ['exec']
      args.push('--skip-git-repo-check')
      // Akorith owns the presentation layer. Structured events keep Codex's
      // progress, tools, file edits, and final response separate and stable.
      args.push('--json')
      if (model) args.push('-m', model)
      if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
      for (const image of options.images || []) args.push('-i', image)
      if (!resume) {
        for (const dir of options.addDirs || []) args.push('--add-dir', dir)
        if (options.profile) args.push('-p', options.profile)
      }
      for (const config of options.configs || []) args.push('-c', config)
      for (const feature of options.enableFeatures || []) args.push('--enable', feature)
      for (const feature of options.disableFeatures || []) args.push('--disable', feature)
      if (options.strictConfig) args.push('--strict-config')
      if (options.search && !resume) args.push('--search')
      if (options.outputSchema) args.push('--output-schema', options.outputSchema)
      if (options.outputFile) args.push('-o', options.outputFile)
      // Codex CLI 0.142 removed the old approval flag from `codex exec`.
      // Keep accepting Akorith's option for cross-provider config, but do not
      // forward unsupported flags that make one-shot runs exit with code 2.
      if (options.oss && !resume) args.push('--oss')
      if (options.localProvider && !resume) args.push('--local-provider', options.localProvider)
      if (options.dangerBypass) args.push('--dangerously-bypass-approvals-and-sandbox')
      if (options.bypassHookTrust) args.push('--dangerously-bypass-hook-trust')
      if (options.ephemeral) args.push('--ephemeral')
      if (options.ignoreUserConfig) args.push('--ignore-user-config')
      if (options.ignoreRules) args.push('--ignore-rules')
      if (options.color && !resume) args.push('--color', options.color)
      // `resume` doesn't take -s, but both forms accept -c overrides
      const sandbox = options.sandbox || (mode === 'act' ? 'workspace-write' : 'read-only')
      if (!resume) args.push('-s', sandbox)
      else args.push('-c', `sandbox_mode="${sandbox}"`)
      // Codex's workspace-write sandbox blocks the network by default, so
      // git push / gh / npm publish fail. Open it when a connection is on.
      if (mode === 'act' && connectionsOn()) {
        args.push('-c', 'sandbox_workspace_write.network_access=true')
      }
      args.push(prompt)
      return args
    },
  },
  opencode: {
    id: 'opencode',
    display: 'OpenCode',
    codename: 'Gaia',
    bin: 'opencode',
    hint: 'model format provider/model (e.g. /model opencode/anthropic/claude-sonnet-4-5)',
    args({ prompt, model, resume, mode, cwd, options = {} }) {
      const args = ['run']
      if (model) args.push('-m', model)
      if (resume) args.push('-c')
      if (options.sessionId) args.push('-s', options.sessionId)
      // OpenCode can retain a project directory through its session/plugin
      // state. Pin every run explicitly so Akorith's -C and /cd boundaries are
      // honored even when the parent process was launched from another repo.
      if (cwd) args.push('--dir', cwd)
      args.push('--format', 'json')
      if (options.thinking === 'show') args.push('--thinking')
      // OpenCode's built-in plan agent is its read-only mode
      if (mode === 'act') args.push('--auto')
      else args.push('--agent', 'plan')
      args.push(prompt)
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
  return commandExists(bin)
}
function run(bin, args) {
  const r = runCommand(bin, args)
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
    found[p.id] = commandExists(p.bin)
  }
  return found
}

// "claude/opus" -> { provider: claude, model: "opus" }; "codex" -> default model.
export function parseModelSpec(spec) {
  const [id, ...rest] = spec.trim().split('/')
  const provider = PROVIDERS[id]
  if (!provider) return null
  return normalizeModelSelection({ provider: provider.id, model: rest.join('/') || null })
}

// What each permission mode means, provider by provider.
export const MODES = {
  view: 'read-only — models can look but never write or execute',
  act: 'act — edits auto-approved, commands sandboxed to the workspace',
}

export function formatModel(selection) {
  const normalized = normalizeModelSelection(selection)
  const p = PROVIDERS[normalized.provider]
  const model = normalized.model || 'default'
  if (normalized.provider === 'opencode' && normalized.model) {
    return `${p.codename.toLowerCase()} · ${normalized.model}`
  }
  const effort = normalized.provider === 'codex' && normalized.reasoningEffort ? ` · ${normalized.reasoningEffort}` : ''
  return `${p.codename.toLowerCase()} · ${p.id}/${model}${effort}`
}

export function codexErrorMessage(line) {
  const plain = stripAnsi(line).replace(/\s+/g, ' ').trim()
  if (/\bWARN(?:ING)?\b/i.test(plain)) return ''
  if (!/\bERROR\b|not supported|invalid (?:request|model)|bad request/i.test(plain)) return ''
  const jsonStart = plain.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(plain.slice(jsonStart))
      const message = payload?.detail?.message || payload?.detail || payload?.error?.message || payload?.message
      if (typeof message === 'string' && message.trim()) return message.trim()
    } catch {
      // Fall through to a readable plain-text diagnostic.
    }
  }
  return plain
    .replace(/^\S+\s+ERROR\s+/, '')
    .replace(/^.*?Bad Request:\s*/i, '')
    .trim()
}

export function parseCodexEvent(line) {
  const plain = stripAnsi(line).trim()
  if (!plain.startsWith('{')) return null
  try {
    const event = JSON.parse(plain)
    return event && typeof event === 'object' && typeof event.type === 'string' ? event : null
  } catch {
    return null
  }
}

function textLines(value) {
  const normalized = String(value ?? '').replace(/\r/g, '')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// A bounded line diff for live file previews. LCS gives clean edits for normal
// source files; very large changed regions use a prefix/suffix fallback so the
// terminal never stalls on a generated file.
export function diffTextLines(before, after, { maxLines = 60 } = {}) {
  const oldLines = textLines(before)
  const newLines = textLines(after)
  const operations = []
  const cells = oldLines.length * newLines.length

  if (cells <= 250_000) {
    const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1))
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
      for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
        table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1])
      }
    }
    let oldIndex = 0
    let newIndex = 0
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
        oldIndex++
        newIndex++
      } else if (newIndex < newLines.length && (oldIndex === oldLines.length || table[oldIndex][newIndex + 1] > table[oldIndex + 1][newIndex])) {
        operations.push({ type: 'add', text: newLines[newIndex++] })
      } else {
        operations.push({ type: 'del', text: oldLines[oldIndex++] })
      }
    }
  } else {
    let prefix = 0
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
    let oldEnd = oldLines.length - 1
    let newEnd = newLines.length - 1
    while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--
      newEnd--
    }
    for (let index = prefix; index <= oldEnd; index++) operations.push({ type: 'del', text: oldLines[index] })
    for (let index = prefix; index <= newEnd; index++) operations.push({ type: 'add', text: newLines[index] })
  }

  const additions = operations.filter((line) => line.type === 'add').length
  const deletions = operations.length - additions
  const limit = Math.max(1, Number(maxLines) || 60)
  return {
    lines: operations.slice(0, limit),
    additions,
    deletions,
    truncated: Math.max(0, operations.length - limit),
  }
}

function fileSnapshot(filePath) {
  try {
    if (!existsSync(filePath)) return { exists: false, text: '', binary: false }
    const text = readFileSync(filePath, 'utf8')
    return { exists: true, text, binary: text.includes('\0') }
  } catch {
    return { exists: existsSync(filePath), text: '', binary: true }
  }
}

function fileLabel(filePath, cwd = '') {
  const clean = String(filePath || '').replace(/\\/g, '/')
  const root = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '')
  if (root && clean.toLowerCase().startsWith((root + '/').toLowerCase())) return clean.slice(root.length + 1)
  return clean.split('/').filter(Boolean).slice(-2).join('/') || 'file'
}

function codexCommand(command) {
  let value = String(command || '').replace(/\s+/g, ' ').trim()
  const shell = value.match(/\s-(?:Command|c|lc)\s+([\s\S]+)$/i)
  if (shell) value = shell[1].trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1)
  }
  return compactCommand(value || 'command', 88)
}

// Per-provider output renderers: turn the raw CLI streams into a quiet,
// readable feed. Every rendered line goes through print() (the spinner's log),
// so the animated status line stays pinned at the bottom for the whole turn.
function createRenderer(providerId, print, setStatus = () => {}, opts = {}) {
  const thinkingMode = opts.thinking || 'hide'
  const reportUsage = typeof opts.onUsage === 'function' ? opts.onUsage : () => {}
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
    let thinkingOpen = false
    let thinkingLines = []
    let execCommand = ''
    let execStatus = null
    let tokenReport = null
    const diagnostics = []
    const flow = createFlowLinePrinter(print)
    const finalAnswer = []
    const fileSnapshots = new Map()
    const shownItems = new Set()
    let structured = false
    let structuredFailed = false
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
      if (/^@@ /.test(plain)) return void print(faint('    ' + plain))
      if (/^\+/.test(plain)) return void print('    ' + diffAdd(plain.slice(1), terminalWidth() - 4))
      if (/^-/.test(plain)) return void print('    ' + diffDel(plain.slice(1), terminalWidth() - 4))
      print(faint('    ' + plain.replace(/^ /, '')))
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
    const renderThinking = (line) => {
      const plain = stripAnsi(line).trimEnd()
      if (!plain) return
      if (thinkingMode === 'hide') return
      if (thinkingMode === 'minimal') {
        if (!thinkingOpen) {
          thinkingOpen = true
          print(faint('  ◐ thinking…'))
        }
        return
      }
      // Show mode collects provider-supplied reasoning until the phase closes.
      // Printing one bounded block avoids dozens of fragmented one-line rows.
      if (!thinkingOpen) {
        thinkingOpen = true
        thinkingLines = []
      }
      thinkingLines.push(plain)
    }
    const closeThinking = () => {
      if (thinkingOpen) {
        thinkingOpen = false
        if (thinkingMode === 'show' && thinkingLines.length) {
          if (!lastBlank) print('')
          for (const row of formatReasoningBlock(thinkingLines)) print(row)
          lastBlank = false
        }
        thinkingLines = []
      }
    }
    const closeExec = () => {
      if (!execCommand && !execStatus) return
      print(toolCardHeader({
        name: 'exec',
        status: execStatus === 'error' ? 'error' : 'completed',
        subtitle: compactCommand(execCommand || 'command'),
      }))
      execCommand = ''
      execStatus = null
      lastBlank = false
    }
    const closePhase = () => {
      closeThinking()
      closeExec()
    }
    const rememberFiles = (item = {}) => {
      for (const change of item.changes || []) {
        const filePath = String(change.path || '')
        if (filePath && !fileSnapshots.has(filePath)) fileSnapshots.set(filePath, fileSnapshot(filePath))
      }
    }
    const renderFileChanges = (item = {}) => {
      for (const change of item.changes || []) {
        const filePath = String(change.path || '')
        if (!filePath) continue
        const before = fileSnapshots.get(filePath)
        const after = fileSnapshot(filePath)
        const kind = change.kind === 'add' ? 'created' : change.kind === 'delete' ? 'deleted' : 'updated'
        if (!before || before.binary || after.binary) {
          print(toolCardHeader({ name: 'edit', status: 'completed', title: fileLabel(filePath, opts.cwd), subtitle: kind }))
          fileSnapshots.delete(filePath)
          continue
        }
        const diff = diffTextLines(before.text, after.text)
        const counts = diff.additions || diff.deletions ? ` · +${diff.additions} -${diff.deletions}` : ''
        print(toolCardHeader({
          name: 'edit',
          status: 'completed',
          title: fileLabel(filePath, opts.cwd),
          subtitle: kind + counts,
        }))
        for (const line of diff.lines) {
          print('    ' + (line.type === 'add'
            ? diffAdd(line.text, terminalWidth() - 4)
            : diffDel(line.text, terminalWidth() - 4)))
        }
        if (diff.truncated) print(faint(`    … ${diff.truncated} more changed lines`))
        fileSnapshots.delete(filePath)
        lastBlank = false
      }
    }
    const renderCodexEvent = (event) => {
      const item = event.item || {}
      if (event.type === 'item.started') {
        if (item.type === 'file_change') {
          rememberFiles(item)
          setStatus('editing files')
        } else if (item.type === 'command_execution') {
          setStatus('running ' + codexCommand(item.command))
        } else if (item.type === 'web_search') {
          setStatus('searching the web')
        }
        return
      }
      if (event.type === 'item.completed') {
        const key = String(item.id || '')
        if (key && shownItems.has(key)) return
        if (key) shownItems.add(key)
        if (item.type === 'agent_message') {
          setStatus('writing response')
          for (const line of String(item.text || '').split(/\r?\n/)) flow(line)
          spokeFromLog = true
          return
        }
        if (item.type === 'reasoning') {
          for (const line of String(item.text || item.summary || '').split(/\r?\n/)) renderThinking(line)
          return
        }
        if (item.type === 'command_execution') {
          closeThinking()
          const failed = Number(item.exit_code) !== 0
          print(toolCardHeader({ name: 'exec', status: failed ? 'error' : 'completed', subtitle: codexCommand(item.command) }))
          const output = compactToolOutput(item.aggregated_output, { maxLines: 4 })
          const useful = failed ? output : output.filter((line) => /^(?:tests?|suites?|pass|fail|duration|exit)\b/i.test(line))
          if (useful.length) {
            for (const row of toolCardBody(useful.map((line) => dim(line)), { width: terminalWidth() })) print(row)
          }
          lastBlank = false
          return
        }
        if (item.type === 'file_change') {
          closeThinking()
          renderFileChanges(item)
          return
        }
        if (item.type === 'web_search') {
          print(toolCardHeader({ name: 'search', status: 'completed', subtitle: compactCommand(item.query || 'web search', 88) }))
          lastBlank = false
          return
        }
        if (item.type === 'mcp_tool_call') {
          const failed = item.status === 'failed' || Boolean(item.error)
          print(toolCardHeader({ name: 'default', status: failed ? 'error' : 'completed', title: item.tool || 'tool', subtitle: item.server || '' }))
          lastBlank = false
        }
        return
      }
      if (event.type === 'turn.completed') {
        const usage = event.usage || {}
        tokenReport = {
          input: Number(usage.input_tokens ?? usage.input) || 0,
          output: Number(usage.output_tokens ?? usage.output) || 0,
          total: Number(usage.total_tokens ?? usage.total) ||
            (Number(usage.input_tokens ?? usage.input) || 0) + (Number(usage.output_tokens ?? usage.output) || 0),
        }
        setStatus('wrapping up')
        return
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        structuredFailed = true
        const message = event.error?.message || event.message || 'Codex turn failed.'
        if (!diagnostics.includes(message)) diagnostics.push(message)
      }
    }
    return {
      stdoutLine(line) {
        const event = parseCodexEvent(line)
        if (event) {
          structured = true
          renderCodexEvent(event)
          return
        }
        finalAnswer.push(line)
      },
      stderrLine(line) {
        const plain = stripAnsi(line).trimEnd()
        if (structured) return
        const diagnostic = codexErrorMessage(plain)
        if (diagnostic && !diagnostics.includes(diagnostic)) diagnostics.push(diagnostic)
        if (dashes < 2) {
          if (/^-{4,}$/.test(plain.trim())) dashes++
          return
        }
        if (plain === 'user') { closePhase(); block = 'suppress'; setStatus('reading prompt'); return }
        if (plain === 'codex') { closePhase(); block = 'say'; inDiff = false; setStatus('writing response'); return }
        if (plain === 'thinking') { closePhase(); block = 'think'; setStatus('thinking through the request'); return }
        if (plain === 'exec') { closePhase(); block = 'exec'; execHeader = true; setStatus('running command'); return }
        if (plain === 'apply patch') { closePhase(); block = 'patch'; patchOk = null; setStatus('editing files'); return }
        if (plain === 'tokens used') { closePhase(); block = 'tokens'; setStatus('wrapping up'); return }
        if (block === 'say') say(line)
        else if (block === 'think') {
          renderThinking(line)
        }
        else if (block === 'exec') {
          if (execHeader) {
            execHeader = false
            const m = plain.match(/-l?c '([\s\S]+)' in /)
            const cmd = m ? m[1] : plain.replace(/ in \/.*$/, '')
            setStatus('running ' + compactCommand(cmd, 42))
            execCommand = cmd
          } else if (/succeeded in \S+:?\s*$/.test(plain)) {
            execStatus = 'completed'
            closeExec()
          } else if (/(failed|exited \d+) in \S+:?\s*$/.test(plain)) {
            execStatus = 'error'
            closeExec()
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
            print(toolCardHeader({ name: 'edit', status: patchOk ? 'completed' : 'error', title: file, subtitle: 'patched' + (patchOk ? '' : ' failed') }))
            lastBlank = false
            patchOk = null
          }
        } else if (block === 'tokens' && plain) {
          // Capture token accounting for the closing footer (was dropped before).
          tokenReport = parseTokenUsage(plain) || tokenReport
          block = 'suppress'
        }
      },
      flush() {
        closePhase()
        // stderr log went missing (future codex versions?) — fall back to stdout
        if (!structured && !spokeFromLog && finalAnswer.some((l) => stripAnsi(l).trim())) {
          for (const line of finalAnswer) flow(line)
        }
        const visibleDiagnostics = structured && !structuredFailed ? [] : diagnostics.slice(0, 3)
        for (const diagnostic of visibleDiagnostics) {
          print(red('  ✗ Codex: ') + bright(diagnostic))
        }
        if (tokenReport) {
          reportUsage(tokenReport)
        }
      },
    }
  }

  if (providerId === 'opencode') {
    // JSON events let us collapse each tool call into one bounded card instead
    // of leaking OpenCode's repeated TODO tables, XML metadata, and full test
    // transcripts into the terminal.
    const emit = createFlowLinePrinter(print, { suppressRuntimeBanner: true })
    const reasoning = []
    const shownTools = new Set()
    let latestUsage = null
    let minimalThinkingShown = false
    const flushReasoning = () => {
      if (!reasoning.length) return
      if (thinkingMode === 'show') {
        for (const row of formatReasoningBlock(reasoning.splice(0))) print(row)
      } else {
        reasoning.length = 0
      }
      minimalThinkingShown = false
    }
    const route = (line) => {
      const event = parseOpenCodeEvent(line)
      if (!event) {
        if (stripAnsi(line).trim()) emit(line)
        return
      }
      const part = event.part || {}
      if (event.type === 'reasoning' || part.type === 'reasoning') {
        const value = String(part.text || event.text || '').trim()
        if (!value || thinkingMode === 'hide') return
        setStatus('thinking through the request')
        if (thinkingMode === 'minimal') {
          if (!minimalThinkingShown) print(faint('  ◐ reasoning…'))
          minimalThinkingShown = true
        } else {
          reasoning.push(...value.split(/\r?\n/))
        }
        return
      }
      if (event.type === 'tool_use' || part.type === 'tool') {
        flushReasoning()
        const state = part.state || {}
        if (!['completed', 'error'].includes(state.status)) return
        const key = `${part.callID || part.id || ''}:${state.status}`
        if (shownTools.has(key)) return
        shownTools.add(key)
        const failed = state.status === 'error' || (Number.isFinite(Number(state.metadata?.exit)) && Number(state.metadata?.exit) !== 0)
        setStatus(failed ? 'tool failed' : `completed ${part.tool || 'tool'}`)
        for (const row of openCodeToolEventLines(event)) print(row)
        return
      }
      if (event.type === 'text' || part.type === 'text') {
        flushReasoning()
        setStatus('writing response')
        for (const row of String(part.text || event.text || '').split(/\r?\n/)) emit(row)
        return
      }
      if (event.type === 'step_finish' || part.type === 'step-finish') {
        flushReasoning()
        if (part.tokens) latestUsage = {
          input: part.tokens.input,
          output: part.tokens.output,
          total: part.tokens.total,
        }
        return
      }
      if (event.type === 'error') {
        flushReasoning()
        print(red('  ✗ OpenCode: ') + bright(String(event.error?.message || event.message || 'provider error')))
      }
    }
    return {
      stdoutLine: route,
      stderrLine: route,
      flush() {
        flushReasoning()
        emit.flush?.()
        if (latestUsage) reportUsage(latestUsage)
      },
    }
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
    flush() { emit.flush?.() },
  }
}

export function formatReasoningBlock(lines = [], { width = terminalWidth(), maxLines = 8 } = {}) {
  const notes = []
  for (const value of lines) {
    const clean = stripAnsi(value).replace(/\s+/g, ' ').trim()
    if (clean && clean !== notes.at(-1)) notes.push(clean)
  }
  if (!notes.length) return []
  const limit = Math.max(3, Number(maxLines) || 8)
  const visible = notes.length > limit
    ? [...notes.slice(0, limit - 2), `… ${notes.length - limit + 1} more reasoning lines`, notes.at(-1)]
    : notes
  const header = violet('    ◆ ') + bold('Reasoning') + faint(` · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`)
  return [header, ...toolCardBody(visible.map((line) => dim(line)), { width: Math.max(32, width) })]
}

export function normalizeProviderMetadata(line) {
  const plain = stripAnsi(line).trim()
  if (!plain) return { skip: false, line }
  if (/^<\/?(?:shell_metadata|tool_metadata)>$/i.test(plain)) return { skip: true, line: '' }
  const timeout = plain.match(/shell tool terminated command after exceeding timeout\s+(\d+)\s*ms/i)
  if (timeout) {
    const seconds = Math.max(1, Math.round(Number(timeout[1]) / 1000))
    return {
      skip: false,
      line: toolCardHeader({ name: 'shell', status: 'error', subtitle: `timed out after ${seconds}s` }),
    }
  }
  if (/^<\/?[a-z_][^>]*>$/i.test(plain)) return { skip: true, line: '' }
  return { skip: false, line }
}

export function parseOpenCodeEvent(line) {
  const plain = stripAnsi(line).trim()
  if (!plain.startsWith('{')) return null
  try {
    const event = JSON.parse(plain)
    return event && typeof event === 'object' && event.type ? event : null
  } catch {
    return null
  }
}

function compactToolTarget(input = {}) {
  const command = input.command || input.cmd
  if (command) return compactCommand(String(command), 88)
  const target = input.filePath || input.path || input.filename || input.pattern || input.query || input.glob
  if (!target) return ''
  const clean = String(target).replace(/\\/g, '/')
  const parts = clean.split('/').filter(Boolean)
  return compactCommand(parts.length > 2 ? parts.slice(-2).join('/') : clean, 88)
}

function compactToolOutput(output, { maxLines = 5 } = {}) {
  const lines = String(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line && !/^\(no output\)$/i.test(line) && !/^<\/?[a-z_][^>]*>$/i.test(line))
  if (!lines.length) return []
  const summary = lines.filter((line) => /^(?:tests?|suites?|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line))
  if (summary.length) return summary.slice(-maxLines)
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, 2), `… ${lines.length - 4} lines omitted`, ...lines.slice(-2)]
}

export function openCodeToolEventLines(event, { width = terminalWidth() } = {}) {
  const part = event?.part || {}
  const state = part.state || {}
  const name = String(part.tool || 'default').toLowerCase()
  const exitCode = Number(state.metadata?.exit)
  const failedExit = Number.isFinite(exitCode) && exitCode !== 0
  const status = state.status === 'error' || failedExit ? 'error' : 'completed'
  const subtitle = compactToolTarget(state.input || {}) || compactCommand(part.title || '', 88)
  const rows = [toolCardHeader({ name, status, subtitle })]
  const showOutput = ['bash', 'shell', 'exec'].includes(name) || status === 'error'
  if (showOutput) {
    const output = state.output || state.error || state.metadata?.output || ''
    const body = compactToolOutput(output)
    if (failedExit) body.push(`exit ${exitCode}`)
    if (body.length) rows.push(...toolCardBody(body.map((line) => dim(line)), { width: Math.max(32, width) }))
  }
  return rows
}

function parseTokenUsage(line) {
  const text = stripAnsi(line).replace(/\s+/g, ' ').trim()
  if (!text) return null
  const usage = { input: 0, output: 0, total: 0 }
  const read = (value) => Number(String(value).replace(/[^\d]/g, '')) || 0
  const patterns = [
    ['input', /(?:input|prompt)\D+(\d[\d,]*)/i],
    ['input', /(\d[\d,]*)\s+(?:input|prompt)\b/i],
    ['output', /(?:output|completion)\D+(\d[\d,]*)/i],
    ['output', /(\d[\d,]*)\s+(?:output|completion)\b/i],
    ['total', /(?:total|used)\D+(\d[\d,]*)/i],
    ['total', /(\d[\d,]*)\s+tokens?\b/i],
  ]
  for (const [key, pattern] of patterns) {
    const match = text.match(pattern)
    if (match) usage[key] = Math.max(usage[key], read(match[1]))
  }
  if (!usage.total && !usage.input && !usage.output) {
    const match = text.match(/(\d[\d,]*)/)
    if (match) usage.total = read(match[1])
  }
  if (!usage.total && (usage.input || usage.output)) usage.total = usage.input + usage.output
  return usage.total || usage.input || usage.output ? usage : null
}

function createFlowLinePrinter(print, { suppressRuntimeBanner = false } = {}) {
  let lastBlank = true
  let suppressListingOutput = false
  // Fenced code block tracking: when we see ```lang we start buffering lines
  // until the closing fence, then render the block with syntax highlighting
  // (or plain if the lang is unknown). A faint left border + 2-space indent
  // gives the block a contained, terminal-ghibson feel.
  let inCode = false
  let codeLang = null
  let codeBuf = []
  const startCode = (line) => {
    inCode = true
    codeLang = normalizeLang(stripAnsi(line).replace(/^```/, '').trim())
    codeBuf = []
    lastBlank = false
  }
  const flushCode = () => {
    inCode = false
    const body = codeBuf.join('\n').replace(/\n$/, '')
    codeBuf = []
    printCodeBlock(body, codeLang)
    lastBlank = true
  }
  const printCodeBlock = (body, lang) => {
    const label = lang ? dim(lang) : faint('code')
    print(faint('    │ ') + label)
    const lines = body.split('\n')
    const styled = highlight(body, lang)
    for (let i = 0; i < styled.length; i++) {
      print(faint('    │ ') + styled[i])
    }
    print(faint('    ╵'))
  }
  const emitPlain = (line) => {
    const plain = stripAnsi(line).trim()
    if (!plain) {
      if (!lastBlank) print('')
      lastBlank = true
      return
    }
    const raw = stripAnsi(line)
    const leading = raw.match(/^ */)?.[0].length || 0
    const aligned = ' '.repeat(Math.max(0, 4 - leading)) + line
    print(aligned)
    lastBlank = false
  }
  const emitDiffAware = diffAwareLine(emitPlain)

  const flow = (line) => {
    const normalized = normalizeProviderMetadata(line)
    if (normalized.skip) return
    line = normalized.line
    const plain = stripAnsi(line).trimEnd()
    const trimmed = plain.trim()

    if (!trimmed) {
      if (inCode) { codeBuf.push(''); return }
      return emitPlain('')
    }
    if (/^```/.test(trimmed)) {
      if (inCode) { flushCode(); return }
      startCode(trimmed); return
    }
    if (inCode) { codeBuf.push(plain); return }
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
  flow.flush = () => {
    if (inCode) flushCode()
  }
  return flow
}

function terminalWidth() {
  const columns = terminalColumns(88)
  return Math.max(52, Math.min(Number.isFinite(columns) ? columns : 88, 110))
}

function emitWrappedParagraph(line, emit) {
  const text = cleanMarkdownText(line)
  for (const part of wrapWords(text, terminalWidth())) emit(bright(part))
}

function emitWrappedBullet(line, emit) {
  const parts = wrapWords(cleanMarkdownText(line), terminalWidth() - 4)
  parts.forEach((part, i) => {
    const prefix = i === 0 ? violet('  • ') : faint('    ')
    emit(prefix + dim(part))
  })
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
  return fitText(oneLine, max, { middle: true })
}

// Print raw provider output, but colorize unified-diff regions: once a real
// diff header (`diff --git` / `@@ -x +y @@`) is seen, '+' lines get an
// Akorith-green background and '-' lines an Akorith-purple background until a
// blank/non-diff line. Guarded by the header so ordinary markdown ("- item")
// is never touched.
function diffAwareLine(print) {
  let inRegion = false
  let card = null // {path, action, adds, dels, headerPrinted}
  let pendingPath = null
  const chip = (action) => {
    if (action === 'created') return green('created')
    if (action === 'deleted') return red('deleted')
    if (action === 'moved') return violet('moved')
    return dim('patched')
  }
  const printCardHeader = () => {
    if (!card || card.headerPrinted) return
    card.headerPrinted = true
    const file = card.path || '?'
    print(violet('    ▸ ') + bold(file.split('/').pop()) + faint('  ' + chip(card.action)) +
      faint('   ' + green('+' + card.adds) + ' ' + red('-' + card.dels)))
  }
  const printCardFooter = () => {
    if (!card) return
    card = null
  }
  const closeRegion = () => {
    if (card && !card.headerPrinted) printCardHeader()
    inRegion = false
    printCardFooter()
  }
  return (line) => {
    const t = stripAnsi(line).replace(/\s+$/, '')
    // diff --git a/x b/y opens a new file's diff; start a card.
    const m = t.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      if (inRegion) {
        if (card && !card.headerPrinted) printCardHeader()
        printCardFooter()
      }
      inRegion = true
      const moved = m[1] !== m[2]
      card = { path: m[2], action: moved ? 'moved' : 'patched', adds: 0, dels: 0, headerPrinted: false }
      return
    }
    if (!inRegion) {
      // A standalone @@ can start a region without a diff --git header.
      if (/^@@ -\d+.*@@/.test(t)) {
        inRegion = true
        card = { path: '?', action: 'patched', adds: 0, dels: 0, headerPrinted: true }
      }
    }
    if (inRegion) {
      if (/^index [0-9a-f]/.test(t)) return
      if (/^new file mode/.test(t)) { if (card) card.action = 'created'; return }
      if (/^deleted file mode/.test(t)) { if (card) card.action = 'deleted'; return }
      if (/^rename from/.test(t) || /^rename to/.test(t)) { if (card) card.action = 'moved'; return }
      if (/^--- /.test(t)) {
        const mm = t.match(/^--- (?:a\/)?(.+)$/)
        if (mm && card && card.path === '?' && mm[1] !== '/dev/null') card.path = mm[1]
        return
      }
      if (/^\+\+\+ /.test(t)) {
        const mm = t.match(/^\+\+\+ (?:b\/)?(.+)$/)
        if (mm && card && mm[1] !== '/dev/null') card.path = mm[1]
        return
      }
      if (/^@@ /.test(t)) {
        printCardHeader()
        return void print(faint('    ' + t))
      }
      if (/^\+/.test(t)) {
        printCardHeader()
        if (card) card.adds++
        return void print('    ' + diffAdd(t.slice(1), terminalWidth() - 4))
      }
      if (/^-/.test(t)) {
        printCardHeader()
        if (card) card.dels++
        return void print('    ' + diffDel(t.slice(1), terminalWidth() - 4))
      }
      if (t === '') {
        closeRegion()
        return void print('')
      }
      if (/^ /.test(t)) {
        printCardHeader()
        return void print(faint('    ' + t.replace(/^ /, '')))
      }
      // anything else ends the diff region
      closeRegion()
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
export function runTurn({ selection, prompt, resume, cwd, mode = 'act', options = {} }, { onSpawn, onLine, onUsage } = {}) {
  const normalized = normalizeModelSelection(selection)
  const provider = PROVIDERS[normalized.provider]
  const args = provider.args({ prompt, model: normalized.model, reasoningEffort: normalized.reasoningEffort, resume, cwd, mode, options })
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' }
    delete env.NO_COLOR
    const resolved = resolveCommand(provider.bin)
    const child = spawn(resolved.command, [...resolved.argsPrefix, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    onSpawn?.(child)

    const spinner = startSpinner(provider.codename.toLowerCase(), provider.display)
    const print = (line) => {
      spinner.log(line)
      if (onLine) onLine(stripAnsi(line).replace(/\s+$/, ''))
    }
    const renderer = createRenderer(provider.id, print, (status) => spinner.setStatus(status), { thinking: options.thinking, onUsage, cwd })
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
