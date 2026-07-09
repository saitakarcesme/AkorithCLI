import * as readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import * as os from 'node:os'
import {
  PROVIDERS, MODES, CONNECTIONS, detectProviders, parseModelSpec, formatModel, runTurn,
  connectionStatus, loadConnections, saveConnections,
} from './providers.js'
import {
  animateBanner, rule, bold, dim, faint, text, violet, green, red, yellow, cyan,
  diffAdd, diffDel, tintCursor, resetCursor,
} from './ui.js'
import { loadConfig, saveConfig, homeRelative } from './state.js'
import {
  archiveSession, createSession, deleteSession, exportSession, findSession, forkSession, listSessions,
  recordSessionTranscript, recordTurn, renameSession, touchSession,
} from './sessions.js'
import { runDoctorCommand, runReviewCommand, runUpdateCommand, buildReviewPatch } from './commands.js'
import { COMMAND_CATALOG, filterCatalog, fuzzyMatch } from './palette.js'
import { filePatch, parseDiff } from './review.js'

const STATIC_MODEL_CHOICES = [
  { label: 'Olympus · GPT-5 Codex', spec: 'codex/gpt-5-codex', aliases: ['gpt 5 codex', 'gpt-5 codex'] },
  { label: 'Olympus · GPT-5.5 High', spec: 'codex/gpt-5.5-high', aliases: ['gpt 5.5 high', 'gpt-5.5-high'] },
  { label: 'Olympus · GPT-5 High', spec: 'codex/gpt-5-high', aliases: ['gpt 5 high', 'gpt-5-high'] },
  { label: 'Atlantis · Claude Fable 5', spec: 'claude/claude-fable-5', aliases: ['fable', 'fable 5', 'fable 5 high'] },
  { label: 'Atlantis · Claude Opus', spec: 'claude/opus', aliases: ['opus'] },
  { label: 'Atlantis · Claude Sonnet', spec: 'claude/sonnet', aliases: ['sonnet'] },
  { label: 'Atlantis · Claude Haiku', spec: 'claude/haiku', aliases: ['haiku'] },
  { label: 'Local · llama3.2', spec: 'ollama/llama3.2', aliases: ['llama', 'llama3.2'] },
]

// Reasoning visibility: hide (spinner only) / minimal (dim summary line) / show (dim full stream).
const THINKING_MODES = {
  hide: 'never show reasoning, only the working spinner',
  minimal: 'a dim one-line thinking marker while reasoning',
  show: 'stream the model reasoning inline, dimmed',
}

let cachedOpenCodeModels = null

function terminalColumns() {
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 88)
  return Math.max(44, Math.min(Number.isFinite(columns) ? columns : 88, 120))
}

function elideMiddle(value, max) {
  if (value.length <= max) return value
  if (max <= 8) return value.slice(0, max)
  const head = Math.ceil((max - 1) * 0.45)
  const tail = Math.floor((max - 1) * 0.55)
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function compactConnections(labels) {
  const joined = labels.join(' · ')
  if (joined.length <= terminalColumns() - 18) return joined
  return `${labels[0]} +${labels.length - 1}`
}

function rawTerminalColumns() {
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 88)
  return Math.max(24, Number.isFinite(columns) ? columns : 88)
}

function displayLength(value) {
  return [...String(value)].length
}

function wrapSubmittedInput(input, width) {
  const words = String(input).trim().split(/\s+/)
  const lines = []
  let line = ''
  for (let word of words) {
    while (displayLength(word) > width) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!line) {
      line = word
    } else if (displayLength(line) + 1 + displayLength(word) <= width) {
      line += ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function rewriteSubmittedLine(line) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return
  const columns = rawTerminalColumns()
  const promptWidth = 2
  if (displayLength(line) + promptWidth <= columns) return
  const rows = Math.max(1, Math.ceil((displayLength(line) + promptWidth) / columns))
  readline.moveCursor(process.stdout, 0, -rows)
  readline.clearScreenDown(process.stdout)
  const chunks = wrapSubmittedInput(line, Math.max(18, columns - promptWidth))
  chunks.forEach((chunk, index) => {
    const prefix = index === 0 ? text(bold('❯ ')) : faint('  ')
    console.log(prefix + text(bold(chunk)))
  })
}

function normalizeModelAlias(value) {
  return String(value)
    .toLowerCase()
    .replace(/[._/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripCommandAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

function loadOpenCodeModels() {
  if (cachedOpenCodeModels) return cachedOpenCodeModels
  const result = spawnSync('opencode', ['models'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 5000,
  })
  if (result.status !== 0) {
    cachedOpenCodeModels = []
    return cachedOpenCodeModels
  }
  const seen = new Set()
  cachedOpenCodeModels = stripCommandAnsi(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(opencode|opencode-go)\/[A-Za-z0-9._-]+$/.test(line))
    .filter((line) => {
      if (seen.has(line)) return false
      seen.add(line)
      return true
    })
  return cachedOpenCodeModels
}

function staticChoice(choice) {
  return { ...choice, parsed: parseModelSpec(choice.spec), visibleSpec: choice.spec }
}

function openCodeChoice(modelID) {
  const providerID = modelID.split('/')[0]
  const modelName = modelID.split('/').slice(1).join('/') || modelID
  return {
    label: `Gaia · ${modelName}`,
    spec: `opencode/${modelID}`,
    visibleSpec: modelID,
    parsed: { provider: 'opencode', model: modelID },
    aliases: [modelID, modelName, modelID.split('/').at(-1), `gaia ${modelName}`, `gaia ${modelID}`],
  }
}

function choiceAliases(choice) {
  return [choice.label, choice.spec, choice.visibleSpec, ...(choice.aliases || [])].filter(Boolean)
}

function resolveModelSpec(input, choices = []) {
  const raw = input.trim()
  if (!raw) return null
  const normalized = normalizeModelAlias(raw)
  const exact = choices.find((choice) => choiceAliases(choice).some((alias) => normalizeModelAlias(alias) === normalized))
  if (exact) return exact.parsed
  if (/^(opencode|opencode-go)\/[A-Za-z0-9._-]+$/.test(raw)) {
    return { provider: 'opencode', model: raw }
  }
  return parseModelSpec(raw)
}

const COMMANDS = [
  '/help', '/models', '/model', '/mode', '/thinking', '/connect', '/options', '/option',
  '/sessions', '/resume', '/fork', '/archive', '/unarchive', '/delete',
  '/review', '/doctor', '/update', '/cd', '/new', '/clear', '/exit', '/quit',
]

function uniqueList(values = []) {
  return [...new Set(values.filter(Boolean).map(String))]
}

function normalizeOptions(options = {}) {
  return {
    ...options,
    addDirs: uniqueList(options.addDirs),
    images: uniqueList(options.images),
    configs: uniqueList(options.configs),
    enableFeatures: uniqueList(options.enableFeatures),
    disableFeatures: uniqueList(options.disableFeatures),
  }
}

function mergeOptions(base = {}, override = {}) {
  return normalizeOptions({
    ...base,
    ...override,
    addDirs: [...(base.addDirs || []), ...(override.addDirs || [])],
    images: [...(base.images || []), ...(override.images || [])],
    configs: [...(base.configs || []), ...(override.configs || [])],
    enableFeatures: [...(base.enableFeatures || []), ...(override.enableFeatures || [])],
    disableFeatures: [...(base.disableFeatures || []), ...(override.disableFeatures || [])],
  })
}

function expandPath(value) {
  return String(value || '').replace(/^~(?=$|\/)/, os.homedir())
}

export async function startRepl({ version, initialModel, initialOptions = {}, initialSessionId = null } = {}) {
  const config = loadConfig()
  const available = detectProviders()
  const persist = (patch) => {
    Object.assign(config, patch)
    saveConfig(config)
  }

  let selection = null
  for (const spec of [initialModel, config.model, 'claude', 'codex', 'opencode']) {
    if (!spec) continue
    const parsed = typeof spec === 'string' ? parseModelSpec(spec) : spec
    if (parsed && available[parsed.provider]) {
      selection = parsed
      break
    }
  }
  if (!selection) {
    console.error('No agent CLI found. Install one of: claude, codex, opencode — then run akorith again.')
    process.exit(1)
  }

  let mode = MODES[config.mode] ? config.mode : 'act'
  let thinking = THINKING_MODES[config.thinking] ? config.thinking : 'hide'
  let turnOptions = mergeOptions(config.options || {}, initialOptions)

  // One conversation thread per provider; resume flags only make sense after
  // the first turn of that provider in this Akorith session.
  const started = { claude: false, codex: false, opencode: false, ollama: false }
  let activeSession = null
  let activeChild = null
  let awaitingModelPick = false
  let modelPickChoices = []
  let modelPickSelected = 0
  let modelPickerRows = 0
  let lastSigint = 0
  let bootNotice = null
  // interactive session picker state
  let awaitingSessionPick = false
  let sessionPickChoices = []
  let sessionPickSelected = 0
  let sessionPickerRows = 0
  let sessionPickAll = false
  let sessionPickConfirm = null // {verb, target} when awaiting y/n
  // command palette (ctrl+p) state
  let awaitingPalette = false
  let paletteQuery = ''
  let paletteChoices = []
  let paletteSelected = 0
  let paletteRows = 0
  // interactive review browser state
  let awaitingReview = false
  let reviewAllFiles = []
  let reviewFiles = []
  let reviewSelected = 0
  let reviewExpanded = new Set()
  let reviewFilter = ''
  let reviewFiltering = false
  let reviewRows = 0
  let reviewArgs = null

  function resetStarted(next = {}) {
    for (const key of Object.keys(started)) started[key] = Boolean(next[key])
  }

  function activateSession(session, { quiet = false } = {}) {
    if (!session) return false
    activeSession = session
    if (session.cwd) {
      try {
        process.chdir(expandPath(session.cwd))
      } catch {
        if (!quiet) console.log(yellow('Session cwd is unavailable; staying in ') + homeRelative(process.cwd()))
      }
    }
    if (session.selection && available[session.selection.provider]) selection = session.selection
    else if (session.selection && !quiet) {
      console.log(yellow(`${session.selection.provider} CLI is not available; keeping ${formatModel(selection)}.`))
    }
    if (MODES[session.mode]) mode = session.mode
    resetStarted(session.providerStarted || {})
    if (!quiet) {
      console.log(green('✓ ') + 'Resumed ' + bold(session.name || session.id) + faint(' · ' + session.id))
      // Replay the last few turns inline so you land somewhere familiar.
      replayTranscript(session)
    }
    return true
  }

  // Reprint prior turns from the transcript tail. Each turn is framed by a
  // short marker showing the model + outcome; the assistant excerpt is shown
  // dimmed so it reads as recalled history, not a fresh run.
  function replayTranscript(session) {
    const list = Array.isArray(session.transcript) ? session.transcript : []
    if (!list.length) return
    const last = list.slice(-6)
    console.log(faint('  last ' + last.length + ' turn' + (last.length === 1 ? '' : 's') + ':'))
    for (const t of last) {
      const model = t.model ? `${t.provider}/${t.model}` : (t.provider || 'model')
      const tick = t.code === 0 ? green('✓') : t.code === 130 ? yellow('■') : red('✗')
      console.log(faint('  ' + tick + ' ' + model))
      if (t.prompt) console.log(faint('    ❯ ' + elideMiddle(t.prompt.replace(/\s+/g, ' ').trim(), Math.max(40, terminalColumns() - 8))))
      if (t.excerpt) {
        const ex = t.excerpt.replace(/\s+$/, '').split('\n').slice(-3)
        for (const line of ex) console.log(faint('    ' + line.slice(0, Math.max(40, terminalColumns() - 6))))
      }
    }
    console.log()
  }

  function ensureActiveSession() {
    if (!activeSession) {
      activeSession = createSession({ cwd: process.cwd(), selection, mode })
    } else {
      activeSession = touchSession(activeSession.id, { cwd: process.cwd(), selection, mode }) || activeSession
    }
    return activeSession
  }

  if (initialSessionId) {
    const found = findSession(initialSessionId)
    if (found) activateSession(found, { quiet: true })
    else bootNotice = yellow(`Session not found: ${initialSessionId}`)
  }

  console.clear()
  tintCursor()
  await animateBanner(version)
  console.log()
  printStatus()
  printConnections()
  printHint()
  if (bootNotice) console.log(bootNotice)
  console.log()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: text(bold('❯ ')) ,
    completer(line) {
      if (line.startsWith('/model ')) {
        const partial = line.slice(7)
        const specs = Object.keys(PROVIDERS).filter((id) => available[id])
        const hits = specs.filter((s) => s.startsWith(partial)).map((s) => '/model ' + s)
        return [hits.length ? hits : [], line]
      }
      if (line.startsWith('/')) {
        const hits = COMMANDS.filter((c) => c.startsWith(line))
        return [hits.length ? hits : COMMANDS, line]
      }
      return [[], line]
    },
  })

  function printConnections() {
    const status = connectionStatus()
    const on = Object.entries(status).filter(([, c]) => c.on).map(([, c]) => c.label)
    const off = Object.entries(status).filter(([, c]) => !c.on && c.ready).map(([, c]) => c.label)
    const parts = []
    if (on.length) parts.push(green('⚡ ' + compactConnections(on)))
    if (off.length) parts.push(faint('○ ' + off.join(' · ')))
    if (!on.length && !off.length) return
    console.log(faint('connected  ') + parts.join(faint('   ')))
  }

  function printHint() {
    const hint =
      terminalColumns() < 72
        ? 'Type a task. /help for commands.'
        : 'Type a task. /help for commands, /connect for integrations, ! to run shell.'
    console.log(dim(hint))
  }

  function connectMenu() {
    const status = connectionStatus()
    console.log()
    console.log(text(bold('Connections')) + dim(' — external tools models can drive in act mode'))
    for (const [id, c] of Object.entries(status)) {
      const dot = !c.ready ? red('✗') : c.on ? green('⚡') : faint('○')
      const state = !c.ready ? red('unavailable') : c.on ? green('on') : faint('off')
      console.log(`  ${dot} ${text(bold(c.label.padEnd(8)))} ${state.padEnd(11)} ${faint(c.detail)}`)
      console.log(`      ${faint(c.note)}`)
    }
    console.log()
    console.log(faint('  /connect <name> on|off   toggle a connection (e.g. /connect github off)'))
    console.log()
  }

  function printStatus() {
    const narrow = terminalColumns() < 72
    const model = narrow
      ? `${selection.provider}/${selection.model || 'default'}`
      : formatModel(selection)
    const cwd = homeRelative(process.cwd())
    const state = narrow
      ? started[selection.provider] ? 'cont' : 'new'
      : started[selection.provider] ? 'session continues' : 'new session'
    const fixed = model.length + mode.length + state.length + 14
    const cwdBudget = Math.max(12, terminalColumns() - fixed)
    const parts = [
      green('●') + ' ' + dim(model),
      mode === 'act' ? green('act') : yellow('view'),
      faint(elideMiddle(cwd, cwdBudget)),
      faint(state),
    ]
    console.log(parts.join(faint('  ·  ')))
  }

  function listModels() {
    console.log()
    console.log(text(bold('Providers')) + dim(' — switch with /model <provider>[/<model>]'))
    for (const p of Object.values(PROVIDERS)) {
      const status = available[p.id] ? green('ready') : red('not installed')
      const active = selection.provider === p.id ? violet('▸') : ' '
      console.log(`  ${active} ${text(bold(p.id.padEnd(9)))} ${violet(p.codename.padEnd(9))} ${status}`)
      console.log(`      ${faint(p.hint)}`)
    }
    console.log()
  }

  function modelSpec(selection_) {
    return `${selection_.provider}${selection_.model ? '/' + selection_.model : ''}`
  }

  function isCurrentChoice(choice) {
    return choice.parsed && choice.parsed.provider === selection.provider && choice.parsed.model === selection.model
  }

  function modelChoices() {
    const seen = new Set()
    const choices = [
      ...STATIC_MODEL_CHOICES.map(staticChoice),
      ...(available.opencode ? loadOpenCodeModels().map(openCodeChoice) : []),
    ]
    return choices
      .filter(({ parsed, spec }) => {
        if (!parsed || !available[parsed.provider] || seen.has(spec)) return false
        seen.add(spec)
        return true
      })
  }

  function currentModelChoiceIndex(choices) {
    const index = choices.findIndex((choice) => isCurrentChoice(choice))
    return index >= 0 ? index : 0
  }

  function modelPickerLines() {
    const specWidth = Math.max(18, Math.min(34, terminalColumns() - 36))
    const lines = [rule('model picker · ↑/↓ · enter', violet, '╭')]
    if (!modelPickChoices.length) {
      lines.push(red('  No installed providers are available.'))
    }
    modelPickChoices.forEach((choice, index) => {
      const selected = index === modelPickSelected
      const current = isCurrentChoice(choice)
      const cursor = selected ? violet('▸') : faint(' ')
      const active = current ? green('●') : faint('○')
      const number = selected ? violet(String(index + 1).padStart(2)) : faint(String(index + 1).padStart(2))
      const label = selected ? text(bold(choice.label.padEnd(28))) : text(choice.label.padEnd(28))
      const specText = choice.visibleSpec || choice.spec
      const spec = selected ? violet(elideMiddle(specText, specWidth)) : faint(elideMiddle(specText, specWidth))
      lines.push(`  ${cursor} ${active} ${number} ${label} ${spec}`)
    })
    lines.push(rule('enter selects · type alias/spec · q or esc cancels', dim, '╰'))
    lines.push(faint('examples: gpt 5.5 high · fable 5 · opencode-go/glm-5.2'))
    return lines
  }

  function printModelPicker() {
    const lines = modelPickerLines()
    for (const line of lines) console.log(line)
    modelPickerRows = lines.length
  }

  function clearModelPicker() {
    if (!process.stdout.isTTY || !modelPickerRows) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    readline.moveCursor(process.stdout, 0, -modelPickerRows)
    readline.clearScreenDown(process.stdout)
  }

  function redrawModelPicker() {
    clearModelPicker()
    printModelPicker()
    rl.prompt(true)
  }

  function closeModelPicker() {
    awaitingModelPick = false
    modelPickerRows = 0
    modelPickChoices = []
    modelPickSelected = 0
  }

  function moveModelPicker(delta) {
    if (!awaitingModelPick || !modelPickChoices.length) return
    modelPickSelected = (modelPickSelected + delta + modelPickChoices.length) % modelPickChoices.length
    if (rl.line) {
      rl.line = ''
      rl.cursor = 0
    }
    redrawModelPicker()
  }

  function showModelPicker() {
    if (activeChild) {
      console.log(dim('Model picker opens after the current turn finishes.'))
      return
    }
    modelPickChoices = modelChoices()
    modelPickSelected = currentModelChoiceIndex(modelPickChoices)
    awaitingModelPick = true
    console.log()
    printModelPicker()
  }

  function applyModel(parsed) {
    if (!available[parsed.provider]) {
      console.log(yellow(`${parsed.provider} CLI is not installed on this machine.`))
      return false
    }
    selection = parsed
    persist({ model: modelSpec(selection) })
    if (activeSession) activeSession = touchSession(activeSession.id, { selection }) || activeSession
    console.log(green('✓ ') + 'Now talking to ' + bold(formatModel(selection)))
    return true
  }

  // ── interactive session picker ───────────────────────────────────────
  // Mirrors the model picker: scroll with ↑/↓, enter resumes, ctrl+r renames,
  // ctrl+d deletes (with a y/n confirm), e exports a markdown transcript, q/esc
  // cancels. Triggered by `/sessions` with no args; `--all` lists every folder.
  function sessionPickerLines() {
    const lines = [rule(`sessions · ↑/↓ · enter resume · ctrl+r rename · ctrl+d delete · e export${sessionPickAll ? ' · --all' : ''}`, violet, '╭')]
    if (!sessionPickChoices.length) {
      lines.push(faint('  No sessions yet. The first real prompt creates one.'))
    }
    const idBudget = 14
    const modelBudget = 24
    const promptBudget = Math.max(16, terminalColumns() - idBudget - modelBudget - 14)
    sessionPickChoices.forEach((session, index) => {
      const selected = index === sessionPickSelected
      const active = activeSession?.id === session.id
      const cursor = selected ? violet('▸') : faint(' ')
      const mark = active ? green('●') : session.archived ? yellow('■') : faint('○')
      const num = selected ? violet(String(index + 1).padStart(2)) : faint(String(index + 1).padStart(2))
      const id = selected ? text(bold(session.id.slice(0, idBudget).padEnd(idBudget))) : text(session.id.slice(0, idBudget).padEnd(idBudget))
      const model = (session.selection ? formatModel(session.selection) : 'unknown').slice(0, modelBudget)
      const modelCell = selected ? violet(model.padEnd(modelBudget)) : faint(model.padEnd(modelBudget))
      const promptText = (session.lastPrompt || '(no turns yet)').replace(/\s+/g, ' ').trim()
      const promptCell = (selected ? text : faint)(elideMiddle(promptText, promptBudget))
      lines.push(`  ${cursor} ${mark} ${num} ${id} ${modelCell} ${promptCell}`)
    })
    lines.push(rule('enter resume · ctrl+r rename · ctrl+d delete · e export · q or esc cancels', dim, '╰'))
    return lines
  }

  function printSessionPicker() {
    const lines = sessionPickerLines()
    for (const line of lines) console.log(line)
    sessionPickerRows = lines.length
  }

  function clearSessionPicker() {
    if (!process.stdout.isTTY || !sessionPickerRows) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    readline.moveCursor(process.stdout, 0, -sessionPickerRows)
    readline.clearScreenDown(process.stdout)
  }

  function redrawSessionPicker() {
    clearSessionPicker()
    sessionPickChoices = listSessions({ all: sessionPickAll, cwd: sessionPickAll ? null : process.cwd() })
    if (sessionPickSelected >= sessionPickChoices.length) sessionPickSelected = Math.max(0, sessionPickChoices.length - 1)
    printSessionPicker()
    rl.prompt(true)
  }

  function closeSessionPicker() {
    awaitingSessionPick = false
    sessionPickerRows = 0
    sessionPickChoices = []
    sessionPickSelected = 0
    sessionPickConfirm = null
  }

  function moveSessionPicker(delta) {
    if (!awaitingSessionPick || !sessionPickChoices.length) return
    sessionPickSelected = (sessionPickSelected + delta + sessionPickChoices.length) % sessionPickChoices.length
    if (rl.line) { rl.line = ''; rl.cursor = 0 }
    redrawSessionPicker()
  }

  function showSessionPicker({ all = false } = {}) {
    if (activeChild) {
      console.log(dim('Session picker opens after the current turn finishes.'))
      return
    }
    sessionPickAll = all
    sessionPickChoices = listSessions({ all, cwd: all ? null : process.cwd() })
    if (!sessionPickChoices.length) {
      console.log()
      console.log(text(bold('Sessions')) + dim(' — current folder'))
      console.log(faint('  No sessions yet. The first real prompt creates one.'))
      console.log()
      return
    }
    const activeIdx = sessionPickChoices.findIndex((s) => s.id === activeSession?.id)
    sessionPickSelected = activeIdx >= 0 ? activeIdx : 0
    awaitingSessionPick = true
    console.log()
    printSessionPicker()
  }

  function currentSessionPick() {
    return sessionPickChoices[sessionPickSelected] || null
  }

  function resumeSessionPick() {
    const s = currentSessionPick()
    if (!s) return
    const fresh = findSession(s.id)
    closeSessionPicker()
    if (fresh) activateSession(fresh)
    else console.log(red('Session no longer exists.'))
    printStatus()
  }

  function renameSessionPick() {
    const s = currentSessionPick()
    if (!s) return
    // Switch readline into inline-rename mode: clear the picker, prompt
    // for a new name on the input line; the next `line` event commits.
    clearSessionPicker()
    closeSessionPicker()
    console.log(violet('  ▸ ') + dim('rename ') + bold(s.id) + faint(' — type new name, enter to save, esc to cancel'))
    rl.question(text(bold('name ❯ ')) || '', (answer) => {
      const name = String(answer).trim()
      if (name) {
        renameSession(s.id, name)
        console.log(green('✓ ') + 'Renamed to ' + bold(name))
      } else {
        console.log(dim('Rename cancelled.'))
      }
    })
  }

  function exportSessionPick() {
    const s = currentSessionPick()
    if (!s) return
    // Best-effort: print the transcript markdown to the terminal so the user
    // can pipe/redirect it.
    const body = exportSession(s.id) || '(session not found)'
    console.log()
    console.log(rule(`export · ${s.id}`, violet, '╭'))
    console.log(body.trimEnd())
    console.log(rule('╰', dim, '╰'))
  }

  function deleteSessionPick() {
    const s = currentSessionPick()
    if (!s) return
    if (sessionPickConfirm?.verb === 'delete' && sessionPickConfirm.target === s.id) {
      deleteSession(s.id)
      if (activeSession?.id === s.id) { activeSession = null; resetStarted() }
      sessionPickConfirm = null
      redrawSessionPicker()
      console.log(green('✓ ') + `Deleted ${s.id}.`)
    } else {
      sessionPickConfirm = { verb: 'delete', target: s.id }
      console.log(red('  ⚠ press ctrl+d again to delete ') + bold(s.id))
    }
  }

  // ── end session picker ──────────────────────────────────────────────

  // ── command palette (ctrl+p) ─────────────────────────────────────────
  // A filterable overlay over the command catalog. Typing filters the list
  // incrementally (fuzzy match on cmd + title + desc); ↑/↓ move, enter runs,
  // esc/q cancels, backspace edits the query. Mirrors the model picker's
  // redraw-in-place style.
  function paletteLines() {
    const lines = [rule(`command palette · type to filter · ↑/↓ · enter`, violet, '╭')]
    if (!paletteChoices.length) {
      lines.push(red('  No matching commands.'))
    }
    const cmdBudget = 26
    const titleBudget = 22
    const descBudget = Math.max(16, terminalColumns() - cmdBudget - titleBudget - 10)
    paletteChoices.slice(0, 10).forEach((entry, index) => {
      const selected = index === paletteSelected
      const cursor = selected ? violet('▸') : faint(' ')
      const cmd = selected ? text(bold(entry.cmd.slice(0, cmdBudget).padEnd(cmdBudget))) : faint(entry.cmd.slice(0, cmdBudget).padEnd(cmdBudget))
      const title = (selected ? text : faint)(entry.title.slice(0, titleBudget).padEnd(titleBudget))
      const desc = faint(elideMiddle(entry.desc, descBudget))
      lines.push(`  ${cursor} ${cmd} ${title} ${desc}`)
    })
    if (paletteChoices.length > 10) lines.push(faint('  … ' + (paletteChoices.length - 10) + ' more — narrow the query'))
    lines.push(rule('enter runs · esc/q cancels', dim, '╰'))
    return lines
  }

  function printPalette() {
    const lines = paletteLines()
    for (const line of lines) console.log(line)
    paletteRows = lines.length
  }

  function clearPalette() {
    if (!process.stdout.isTTY || !paletteRows) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    readline.moveCursor(process.stdout, 0, -paletteRows)
    readline.clearScreenDown(process.stdout)
  }

  function redrawPalette() {
    clearPalette()
    paletteChoices = filterCatalog(paletteQuery)
    if (paletteSelected >= paletteChoices.length) paletteSelected = Math.max(0, paletteChoices.length - 1)
    printPalette()
    rl.prompt(true)
  }

  function closePalette() {
    awaitingPalette = false
    paletteRows = 0
    paletteChoices = []
    paletteSelected = 0
    paletteQuery = ''
  }

  function showPalette() {
    if (activeChild || busy || closing || awaitingModelPick || awaitingSessionPick) return
    paletteQuery = ''
    paletteChoices = filterCatalog('')
    paletteSelected = 0
    awaitingPalette = true
    console.log()
    printPalette()
    rl.line = ''
    rl.cursor = 0
    rl.prompt(true)
  }

  function movePalette(delta) {
    if (!awaitingPalette || !paletteChoices.length) return
    const cap = Math.min(paletteChoices.length, 10)
    paletteSelected = (paletteSelected + delta + cap) % cap
    redrawPalette()
  }

  function runPalette() {
    const entry = paletteChoices[paletteSelected]
    if (!entry) return
    const cmd = entry.cmd.split(' ')[0]
    closePalette()
    rl.line = ''
    rl.cursor = 0
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    console.log()
    queue.push(cmd)
    void pump()
  }

  // Interpret a submitted line as a fuzzy query against the catalog. If it
  // matches exactly one entry, run it. If several, re-filter and stay open
  // (user then arrows + enter). If none, report and reopen. An empty line
  // runs the highlighted entry — same as pressing enter on the readline.
  function handlePaletteInput(input) {
    const query = String(input || '').trim()
    if (!query) { runPalette(); return }
    const matches = filterCatalog(query)
    if (matches.length === 1) {
      paletteSelected = 0
      paletteChoices = matches
      runPalette()
      return
    }
    if (matches.length > 1) {
      paletteQuery = query
      paletteChoices = matches
      paletteSelected = 0
      clearPalette()
      printPalette()
      rl.line = ''
      rl.cursor = 0
      rl.prompt(true)
      return
    }
    console.log(red('No matching command for "') + bold(query) + red('" — type a different query, or esc to cancel.'))
    showPalette()
  }

  // ── end command palette ─────────────────────────────────────────────

  // ── interactive review browser ──────────────────────────────────────
  // Renders a file list from the current diff. The active file's hunks can
  // be expanded inline (colored diff bars, same as the live feed). `r`
  // sends the active file's diff to the model for a code review.
  function reviewKey(file) {
    return file?.path || ''
  }

  function reviewHaystack(file) {
    return `${file.path} ${file.oldPath || ''} ${file.summary || ''}`
  }

  function applyReviewFilter({ keepPath = null } = {}) {
    const query = reviewFilter.trim()
    reviewFiles = query
      ? reviewAllFiles.filter((file) => fuzzyMatch(query, reviewHaystack(file)))
      : reviewAllFiles.slice()
    if (keepPath) {
      const next = reviewFiles.findIndex((file) => reviewKey(file) === keepPath)
      reviewSelected = next >= 0 ? next : 0
    } else if (reviewSelected >= reviewFiles.length) {
      reviewSelected = Math.max(0, reviewFiles.length - 1)
    }
  }

  function setReviewFilter(value) {
    const keepPath = reviewKey(reviewFiles[reviewSelected])
    reviewFilter = String(value || '')
    applyReviewFilter({ keepPath })
    redrawReview()
  }

  function handleReviewFilterKey(str, key = {}) {
    if (key.name === 'return') {
      reviewFiltering = false
      redrawReview()
      return
    }
    if (key.name === 'escape') {
      reviewFiltering = false
      redrawReview()
      return
    }
    if (key.name === 'u' && key.ctrl) {
      setReviewFilter('')
      return
    }
    if (key.name === 'backspace') {
      setReviewFilter(reviewFilter.slice(0, -1))
      return
    }
    if (str && str.length === 1 && !key.ctrl && !key.meta && !/[\r\n]/.test(str)) {
      setReviewFilter(reviewFilter + str)
    }
  }

  function reviewLines() {
    const count = reviewFilter
      ? `${reviewFiles.length}/${reviewAllFiles.length} files`
      : `${reviewFiles.length} file${reviewFiles.length === 1 ? '' : 's'}`
    const filter = reviewFilter || reviewFiltering
      ? ` · filter:${reviewFiltering ? violet(reviewFilter || ' ') : faint(reviewFilter)}`
      : ''
    const lines = [rule(`review · ${count}${filter} · ↑/↓ · enter expand · r review · q esc`, violet, '╭')]
    if (!reviewFiles.length) {
      lines.push(red('  No files match this filter.'))
    }
    reviewFiles.forEach((f, index) => {
      const selected = index === reviewSelected
      const open = reviewExpanded.has(reviewKey(f))
      const cursor = selected ? violet('▸') : faint(' ')
      const mark = f.binary ? yellow('■') : open ? green('▾') : faint('▸')
      const chip = f.summary === 'new file' ? green('created')
        : f.summary === 'deleted' ? red('deleted')
        : f.summary === 'renamed' ? violet('moved')
        : f.binary ? yellow('binary')
        : dim('patched')
      const path = selected ? text(bold(f.path)) : text(f.path)
      const counts = f.binary ? '' : faint('  ' + green('+' + f.adds) + ' ' + red('-' + f.dels))
      lines.push(`  ${cursor} ${mark} ${path} ${chip}${counts}`)
      if (open && !f.binary) {
        for (const hunk of f.hunks) {
          lines.push(faint('  │ ' + hunk.header))
          for (const l of hunk.lines) {
            const body = l.slice(1)
            if (/^\+/.test(l)) lines.push(diffAdd(body))
            else if (/^-/.test(l)) lines.push(diffDel(body))
            else if (/^ /.test(l)) lines.push(faint('  │ ' + body))
            else lines.push(faint('  │ ' + l))
          }
        }
      }
    })
    lines.push(rule(reviewFiltering ? 'type filter · enter done · esc done · ctrl+u clear' : '/ filter · c clear · r review file · n/p next/prev · a all · q esc', dim, '╰'))
    return lines
  }

  function printReview() {
    const lines = reviewLines()
    for (const line of lines) console.log(line)
    reviewRows = lines.length
  }

  function clearReview() {
    if (!process.stdout.isTTY || !reviewRows) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    readline.moveCursor(process.stdout, 0, -reviewRows)
    readline.clearScreenDown(process.stdout)
  }

  function redrawReview() {
    clearReview()
    printReview()
    rl.prompt(true)
  }

  function closeReview() {
    awaitingReview = false
    reviewRows = 0
    reviewAllFiles = []
    reviewFiles = []
    reviewSelected = 0
    reviewExpanded = new Set()
    reviewFilter = ''
    reviewFiltering = false
    reviewArgs = null
  }

  function moveReview(delta) {
    if (!reviewFiles.length) return
    reviewSelected = (reviewSelected + delta + reviewFiles.length) % reviewFiles.length
    redrawReview()
  }

  function toggleReview() {
    const key = reviewKey(reviewFiles[reviewSelected])
    if (!key) return
    if (reviewExpanded.has(key)) reviewExpanded.delete(key)
    else reviewExpanded.add(key)
    redrawReview()
  }

  async function reviewFile() {
    const f = reviewFiles[reviewSelected]
    if (!f || f.binary) return
    const selectedPath = reviewKey(f)
    const expanded = new Set(reviewExpanded)
    const filter = reviewFilter
    clearReview()
    const patch = filePatch(f)
    const prompt = [`Focus on ${f.path}.`, reviewArgs?.prompt].filter(Boolean).join(' ')
    const review = { ...(reviewArgs || {}), uncommitted: false, base: null, commit: null, patch, title: f.path, prompt }
    console.log(rule(`${formatModel(selection)} · review · ${f.path}`, violet, '╭'))
    const startedAt = Date.now()
    const code = await runReviewCommand(
      { selection, mode: 'view', cwd: process.cwd(), options: turnOptions, review },
      { onSpawn: (child) => (activeChild = child) },
    )
    activeChild = null
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    console.log(code === 0 ? rule(`✓ review done · ${seconds}s`, green, '╰') : rule(`✗ review exited · code ${code}`, red, '╰'))
    console.log()
    // Reopen the browser at the same position after the review completes.
    showReview(reviewArgs, { selectedPath, expanded, filter })
  }

  function showReview(args, { selectedPath = null, expanded = null, filter = '' } = {}) {
    // Build the patch from the same source as the one-shot /review.
    const patch = buildReviewPatch({ cwd: process.cwd(), ...args })
    if (!patch) {
      console.log(dim('No diff found to review.'))
      return
    }
    reviewAllFiles = parseDiff(patch)
    if (!reviewAllFiles.length) {
      console.log(dim('No changed files in this diff.'))
      return
    }
    reviewArgs = args
    reviewFilter = filter
    reviewFiltering = false
    reviewExpanded = expanded ? new Set(expanded) : new Set()
    reviewSelected = 0
    applyReviewFilter({ keepPath: selectedPath })
    if (activeChild || busy || closing || awaitingModelPick || awaitingSessionPick || awaitingPalette) return
    awaitingReview = true
    console.log()
    printReview()
    rl.prompt(true)
  }

  // ── end review browser ──────────────────────────────────────────────

  function splitArgs(value) {
    return [...String(value).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3])
  }

  function formatBool(value) {
    return value ? green('on') : faint('off')
  }

  function persistOptions() {
    turnOptions = normalizeOptions(turnOptions)
    persist({ options: turnOptions })
  }

  function printOptionList(label, values) {
    if (!values?.length) return
    console.log(`  ${violet(label.padEnd(14))} ${values.map((v) => faint(v)).join(dim(' · '))}`)
  }

  function printOptions() {
    console.log()
    console.log(text(bold('Run options')) + dim(' — applied to future model turns where the provider supports them'))
    console.log(`  ${violet('search'.padEnd(14))} ${formatBool(turnOptions.search)}`)
    console.log(`  ${violet('json'.padEnd(14))} ${formatBool(turnOptions.json)}`)
    console.log(`  ${violet('sandbox'.padEnd(14))} ${faint(turnOptions.sandbox || (mode === 'act' ? 'workspace-write' : 'read-only'))}`)
    console.log(`  ${violet('approval'.padEnd(14))} ${faint(turnOptions.approval || 'provider default')}`)
    if (turnOptions.profile) console.log(`  ${violet('profile'.padEnd(14))} ${faint(turnOptions.profile)}`)
    if (turnOptions.outputFile) console.log(`  ${violet('output'.padEnd(14))} ${faint(turnOptions.outputFile)}`)
    if (turnOptions.outputSchema) console.log(`  ${violet('schema'.padEnd(14))} ${faint(turnOptions.outputSchema)}`)
    if (turnOptions.localProvider) console.log(`  ${violet('local'.padEnd(14))} ${faint(turnOptions.localProvider)}`)
    printOptionList('images', turnOptions.images)
    printOptionList('add-dirs', turnOptions.addDirs)
    printOptionList('configs', turnOptions.configs)
    printOptionList('enable', turnOptions.enableFeatures)
    printOptionList('disable', turnOptions.disableFeatures)
    console.log()
    console.log(faint('Examples: /option search on · /option image ./shot.png · /option sandbox read-only'))
    console.log()
  }

  function parseSwitch(value) {
    if (!value || ['on', 'true', 'yes', '1'].includes(value)) return true
    if (['off', 'false', 'no', '0'].includes(value)) return false
    return null
  }

  function setOption(rest) {
    const args = splitArgs(rest)
    if (!args.length) {
      printOptions()
      return
    }
    const [key, ...tail] = args
    const value = tail.join(' ')
    const boolKeys = new Set([
      'search', 'json', 'oss', 'strict-config', 'ephemeral', 'ignore-user-config',
      'ignore-rules', 'dangerously-bypass-approvals-and-sandbox', 'dangerously-bypass-hook-trust',
    ])
    if (key === 'clear') {
      const target = tail[0] || 'all'
      if (target === 'all') turnOptions = normalizeOptions({})
      else if (target === 'images') turnOptions.images = []
      else if (target === 'add-dirs' || target === 'dirs') turnOptions.addDirs = []
      else if (target === 'configs') turnOptions.configs = []
      else if (target === 'features') {
        turnOptions.enableFeatures = []
        turnOptions.disableFeatures = []
      } else if (target === 'output') delete turnOptions.outputFile
      else if (target === 'schema') delete turnOptions.outputSchema
      else {
        console.log(red('Unknown option bucket. ') + dim('Use all, images, add-dirs, configs, features, output, schema.'))
        return
      }
      persistOptions()
      console.log(green('✓ ') + `Cleared ${target}.`)
      return
    }
    if (boolKeys.has(key)) {
      const parsed = parseSwitch(tail[0])
      if (parsed === null) {
        console.log(dim(`Usage: /option ${key} on|off`))
        return
      }
      const map = {
        'strict-config': 'strictConfig',
        'ignore-user-config': 'ignoreUserConfig',
        'ignore-rules': 'ignoreRules',
        'dangerously-bypass-approvals-and-sandbox': 'dangerBypass',
        'dangerously-bypass-hook-trust': 'bypassHookTrust',
      }
      turnOptions[map[key] || key] = parsed
      persistOptions()
      console.log(green('✓ ') + `${key} ${parsed ? 'on' : 'off'}.`)
      return
    }
    if (!value && !['output', 'schema', 'profile', 'approval', 'sandbox', 'local-provider', 'color'].includes(key)) {
      console.log(dim('Usage: /option <key> <value>'))
      return
    }
    if (key === 'image') turnOptions.images.push(expandPath(value))
    else if (key === 'add-dir' || key === 'add-directory') turnOptions.addDirs.push(expandPath(value))
    else if (key === 'config') turnOptions.configs.push(value)
    else if (key === 'enable') turnOptions.enableFeatures.push(value)
    else if (key === 'disable') turnOptions.disableFeatures.push(value)
    else if (key === 'sandbox') turnOptions.sandbox = value
    else if (key === 'approval' || key === 'ask-for-approval') turnOptions.approval = value
    else if (key === 'profile') turnOptions.profile = value || null
    else if (key === 'output' || key === 'output-last-message') turnOptions.outputFile = value ? expandPath(value) : null
    else if (key === 'schema' || key === 'output-schema') turnOptions.outputSchema = value ? expandPath(value) : null
    else if (key === 'local-provider') turnOptions.localProvider = value
    else if (key === 'color') turnOptions.color = value
    else {
      console.log(red('Unknown option. ') + dim('Use /options to see supported run options.'))
      return
    }
    persistOptions()
    console.log(green('✓ ') + 'Option updated.')
  }

  function sessionsForView(args = []) {
    const all = args.includes('--all')
    return listSessions({ all, cwd: all ? null : process.cwd() })
  }

  function printSessions(args = []) {
    const sessions = sessionsForView(args)
    console.log()
    console.log(text(bold('Sessions')) + dim(args.includes('--all') ? ' — all saved sessions' : ' — current folder'))
    if (!sessions.length) {
      console.log(faint('  No sessions yet. The first real prompt creates one.'))
      console.log()
      return
    }
    for (const session of sessions) {
      const active = activeSession?.id === session.id ? green('●') : faint('○')
      const archived = session.archived ? yellow(' archived') : ''
      console.log(`  ${active} ${text(bold(session.id))}${archived} ${faint('· ' + (session.name || 'Untitled'))}`)
      console.log(`    ${violet(formatModel(session.selection || selection))} ${faint('· ' + (session.turns || 0) + ' turns · ' + homeRelative(session.cwd || ''))}`)
      if (session.lastPrompt) console.log(`    ${faint(elideMiddle(session.lastPrompt, terminalColumns() - 8))}`)
    }
    console.log()
  }

  function resolveSessionFromArgs(args) {
    const all = args.includes('--all')
    const last = args.includes('--last')
    const explicit = args.find((arg) => !arg.startsWith('-'))
    if (explicit) return findSession(explicit)
    if (last) return listSessions({ all, cwd: all ? null : process.cwd() })[0] || null
    return null
  }

  function parseReview(rest) {
    const args = splitArgs(rest)
    const review = { uncommitted: false, base: null, commit: null, title: null, prompt: '' }
    const prompt = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--uncommitted') review.uncommitted = true
      else if (arg === '--base') review.base = args[++i]
      else if (arg === '--commit') review.commit = args[++i]
      else if (arg === '--title') review.title = args[++i]
      else prompt.push(arg)
    }
    review.prompt = prompt.join(' ')
    return review
  }

  function handleModelPickerInput(input) {
    const value = input.trim()
    if (value === 'q' || value === 'quit' || value === 'cancel') {
      closeModelPicker()
      console.log(dim('Model switch cancelled.'))
      return
    }
    const selected = value
      ? /^\d+$/.test(value) ? modelPickChoices[Number(value) - 1] : null
      : modelPickChoices[modelPickSelected]
    const parsed = selected ? selected.parsed : resolveModelSpec(value, modelPickChoices)
    if (!parsed) {
      console.log(red('Unknown model. ') + dim('Type a number, alias, or <provider>/<model>.'))
      showModelPicker()
      return
    }
    closeModelPicker()
    applyModel(parsed)
  }

  function help() {
    console.log()
    console.log(text(bold('Commands')))
    console.log(`  ${violet('/model')}          open model picker — also via ⌘M/Alt+M when your terminal sends it`)
    console.log(`  ${violet('/model <spec>')}   switch directly — e.g. /model gpt 5.5 high, /model claude/sonnet`)
    console.log(`  ${violet('/models')}         list providers and how to address their models`)
    console.log(`  ${violet('/mode <m>')}       view (read-only) or act (can edit files) — default act`)
    console.log(`  ${violet('/thinking <m>')}   hide · minimal · show — how model reasoning appears (ctrl+t cycles)`)
    console.log(`  ${violet('/options')}        inspect Codex-style run options: images, add-dir, json, search, sandbox`)
    console.log(`  ${violet('/option <k> <v>')} set a run option — e.g. /option image ./shot.png, /option search on`)
    console.log(`  ${violet('/sessions')}       list saved Akorith sessions for this folder`)
    console.log(`  ${violet('/resume --last')}  resume a saved session; use /sessions --all to browse everything`)
    console.log(`  ${violet('/fork <id>')}      fork a session into a fresh branch of work`)
    console.log(`  ${violet('/review')}         review the current diff; supports --uncommitted, --base, --commit`)
    console.log(`  ${violet('/doctor')}         diagnose local CLIs, auth helpers, and global Akorith install`)
    console.log(`  ${violet('/connect')}        show & toggle GitHub, git, npm integrations`)
    console.log(`  ${violet('/cd <dir>')}       change the active working directory`)
    console.log(`  ${violet('/new')}            start fresh conversations (all providers)`)
    console.log(`  ${violet('/clear')}          clear the screen`)
    console.log(`  ${violet('/exit')}           leave Akorith`)
    console.log(`  ${violet('!<command>')}      run a shell command in place (e.g. !git status)`)
    console.log()
    console.log(dim('Anything else is sent to the active model. Conversations continue per'))
    console.log(dim('provider until /new. Ctrl+C cancels a running turn; twice exits.'))
    console.log(dim('⌘M/Alt+M opens the model picker · ctrl+p opens the command palette · ctrl+t cycles reasoning.'))
    console.log()
  }

  async function handle(line) {
    const input = line.trim()
    if (awaitingModelPick) {
      handleModelPickerInput(input)
      return
    }
    // The interactive session picker is driven entirely by keypress events;
    // any queued `line` (e.g. from piped stdin during the picker) is ignored
    // so an Enter pressed inside readline doesn't double-handle the action.
    if (awaitingSessionPick) return
    // Command palette: on a submitted line, interpret it as a fuzzy query
    // against the catalog. If it matches exactly one entry, run it. If it
    // matches several, re-filter the list and stay open for arrow+enter.
    // Empty line runs the highlighted entry.
    if (awaitingPalette) {
      handlePaletteInput(input)
      return
    }
    if (awaitingReview) return // review browser is keypress-driven
    if (!input) return

    if (input === '/exit' || input === '/quit') {
      queue.length = 0
      rl.close()
      return
    }
    if (input === '/clear') {
      console.clear()
      printStatus()
      return
    }
    if (input === '/help') {
      help()
      return
    }
    if (input === '/options' || input === '/option') {
      printOptions()
      return
    }
    if (input.startsWith('/option ')) {
      setOption(input.slice(8).trim())
      return
    }
    if (input === '/sessions' || input === '/sessions --all' || input.startsWith('/sessions --all')) {
      // Bare `/sessions` (and `/sessions --all`) now open the interactive
      // picker. Other arguments (`/sessions <id>`, legacy use) stay as the
      // static listing via printSessions.
      const rest = splitArgs(input.slice(9).trim()).filter((a) => a && a !== '--all')
      if (!rest.length) {
        showSessionPicker({ all: input.includes('--all') })
        return
      }
      printSessions(splitArgs(input.slice(9).trim()))
      return
    }
    if (input === '/resume' || input.startsWith('/resume ')) {
      const args = splitArgs(input.slice(7).trim())
      const session = resolveSessionFromArgs(args)
      if (!session) {
        console.log(dim('Usage: /resume <session-id|name> or /resume --last'))
        printSessions(args)
        return
      }
      activateSession(session)
      printStatus()
      return
    }
    if (input === '/fork' || input.startsWith('/fork ')) {
      const args = splitArgs(input.slice(5).trim())
      const session = resolveSessionFromArgs(args)
      if (!session) {
        console.log(dim('Usage: /fork <session-id|name> or /fork --last'))
        return
      }
      const forked = forkSession(session.id, { cwd: process.cwd(), selection, mode })
      activateSession(forked)
      return
    }
    if (input === '/archive' || input.startsWith('/archive ') || input === '/unarchive' || input.startsWith('/unarchive ')) {
      const unarchive = input.startsWith('/unarchive')
      const offset = unarchive ? 10 : 8
      const args = splitArgs(input.slice(offset).trim())
      const session = resolveSessionFromArgs(args)
      if (!session) {
        console.log(dim(`Usage: /${unarchive ? 'unarchive' : 'archive'} <session-id|name> or --last`))
        return
      }
      archiveSession(session.id, !unarchive)
      console.log(green('✓ ') + `${unarchive ? 'Unarchived' : 'Archived'} ${session.id}.`)
      if (activeSession?.id === session.id) activeSession = { ...session, archived: !unarchive }
      return
    }
    if (input === '/delete' || input.startsWith('/delete ')) {
      const args = splitArgs(input.slice(7).trim())
      const session = resolveSessionFromArgs(args)
      if (!session) {
        console.log(dim('Usage: /delete <session-id|name> or /delete --last'))
        return
      }
      deleteSession(session.id)
      if (activeSession?.id === session.id) {
        activeSession = null
        resetStarted()
      }
      console.log(green('✓ ') + `Deleted ${session.id}.`)
      return
    }
    if (input === '/doctor') {
      runDoctorCommand()
      return
    }
    if (input === '/update') {
      const code = runUpdateCommand({ local: true })
      console.log(code === 0 ? green('✓ Akorith updated from this repo.') : red('Akorith update failed.'))
      return
    }
    if (input === '/review') {
      // Bare `/review` opens the interactive file-by-file browser.
      showReview({ uncommitted: true })
      return
    }
    if (input.startsWith('/review ')) {
      const review = parseReview(input.slice(7).trim())
      console.log()
      console.log(rule(`${formatModel(selection)} · review`, violet, '╭'))
      const startedAt = Date.now()
      const code = await runReviewCommand(
        { selection, mode: 'view', cwd: process.cwd(), options: turnOptions, review },
        { onSpawn: (child) => (activeChild = child) },
      )
      activeChild = null
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      console.log(code === 0 ? rule(`✓ review done · ${seconds}s`, green, '╰') : rule(`✗ review exited · code ${code}`, red, '╰'))
      console.log()
      printStatus()
      return
    }
    if (input === '/models') {
      listModels()
      return
    }
    if (input === '/connect' || input.startsWith('/connect ')) {
      const rest = input.slice(8).trim()
      if (!rest) {
        connectMenu()
        return
      }
      const [name, verb] = rest.split(/\s+/)
      if (!CONNECTIONS[name]) {
        console.log(red('Unknown connection. ') + dim('Use: ' + Object.keys(CONNECTIONS).join(', ')))
        return
      }
      if (verb !== 'on' && verb !== 'off') {
        console.log(dim('Usage: /connect ' + name + ' on|off'))
        return
      }
      const probe = connectionStatus()[name]
      if (verb === 'on' && !probe.ready) {
        console.log(red(`${CONNECTIONS[name].label} isn't available — `) + faint(probe.note))
        return
      }
      const chosen = loadConnections() || {}
      chosen[name] = verb === 'on'
      saveConnections(chosen)
      console.log(green('✓ ') + CONNECTIONS[name].label + ' ' + bold(verb) +
        faint(verb === 'on' ? ' — models can use it in act mode' : ' — off'))
      return
    }
    if (input === '/mode' || input.startsWith('/mode ')) {
      const wanted = input.slice(5).trim()
      if (!wanted) {
        console.log()
        for (const [name, desc] of Object.entries(MODES)) {
          const marker = name === mode ? violet('▸') : ' '
          console.log(`  ${marker} ${text(bold(name.padEnd(6)))} ${faint(desc)}`)
        }
        console.log()
        return
      }
      if (!MODES[wanted]) {
        console.log(red('Unknown mode. ') + dim('Use: ' + Object.keys(MODES).join(' or ')))
        return
      }
      mode = wanted
      persist({ mode })
      if (activeSession) activeSession = touchSession(activeSession.id, { mode }) || activeSession
      console.log(green('✓ ') + 'Mode set to ' + bold(mode) + ' ' + faint('— ' + MODES[mode]))
      return
    }
    if (input === '/thinking' || input.startsWith('/thinking ')) {
      const wanted = input.slice(9).trim()
      if (!wanted) {
        console.log()
        for (const [name, desc] of Object.entries(THINKING_MODES)) {
          const marker = name === thinking ? violet('▸') : ' '
          console.log(`  ${marker} ${text(bold(name.padEnd(8)))} ${faint(desc)}`)
        }
        console.log()
        console.log(faint('  /thinking hide|minimal|show · ctrl+t cycles during a turn'))
        console.log()
        return
      }
      if (!THINKING_MODES[wanted]) {
        console.log(red('Unknown thinking mode. ') + dim('Use: ' + Object.keys(THINKING_MODES).join(', ')))
        return
      }
      thinking = wanted
      persist({ thinking })
      console.log(green('✓ ') + 'Reasoning set to ' + bold(thinking) + ' ' + faint('— ' + THINKING_MODES[thinking]))
      return
    }
    if (input === '/new') {
      resetStarted()
      activeSession = null
      console.log(dim('Fresh start — the next message opens a new conversation.'))
      return
    }
    if (input === '/cd' || input.startsWith('/cd ')) {
      const target = input.slice(3).trim() || os.homedir()
      try {
        process.chdir(expandPath(target))
        if (activeSession) activeSession = touchSession(activeSession.id, { cwd: process.cwd() }) || activeSession
      } catch (err) {
        console.log(red(err.message))
      }
      printStatus()
      return
    }
    if (input.startsWith('/model')) {
      const spec = input.slice(6).trim()
      if (!spec) {
        showModelPicker()
        return
      }
      const parsed = resolveModelSpec(spec, modelChoices())
      if (!parsed) {
        console.log(red('Unknown model. ') + dim('Use a preset alias or <provider>/<model>.'))
        return
      }
      applyModel(parsed)
      return
    }
    if (input.startsWith('/')) {
      console.log(dim('Unknown command — /help lists what Akorith understands.'))
      return
    }

    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim()
      if (!cmd) return
      // `cd` must mutate this process, not a subshell
      if (cmd === 'cd' || cmd.startsWith('cd ')) {
        const target = cmd.slice(2).trim() || os.homedir()
        try {
          process.chdir(expandPath(target))
          if (activeSession) activeSession = touchSession(activeSession.id, { cwd: process.cwd() }) || activeSession
        } catch (err) {
          console.log(red(err.message))
        }
        printStatus()
        return
      }
      await new Promise((resolve) => {
        const child = spawn(cmd, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] })
        activeChild = child
        child.on('exit', resolve)
        child.on('error', resolve)
      })
      activeChild = null
      return
    }

    // A real prompt — hand it to the active provider, streaming. The turn is
    // framed by a labeled top rule and a single closing rule that carries the
    // outcome, so the model's output sits cleanly between two thin dividers.
    const session = ensureActiveSession()
    console.log()
    console.log(rule(`${formatModel(selection)} · ${mode}`, violet, '╭'))
    console.log(violet('  ▸ ') + dim(PROVIDERS[selection.provider].codename.toLowerCase()) + faint(' answering'))
    const startedAt = Date.now()
    const transcriptBuf = []
    const code = await runTurn(
      { selection, prompt: input, resume: started[selection.provider], cwd: process.cwd(), mode, options: { ...turnOptions, thinking } },
      {
        onSpawn: (child) => (activeChild = child),
        onLine: (plain) => { if (plain.trim()) transcriptBuf.push(plain) },
      },
    )
    activeChild = null
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    if (code === 0) {
      started[selection.provider] = true
      console.log(rule(`✓ done · ${seconds}s`, green, '╰'))
    } else if (code === 130) {
      console.log(rule('■ cancelled', yellow, '╰'))
    } else {
      console.log(rule(`✗ exited · code ${code}`, red, '╰'))
    }
    activeSession = recordTurn(session.id, { selection, mode, provider: selection.provider, prompt: input, code }) || activeSession
    recordSessionTranscript(session.id, {
      provider: selection.provider,
      model: selection.model,
      prompt: input,
      code,
      output: transcriptBuf.join('\n'),
    })
    console.log()
    printStatus()
  }

  // Lines are queued, not dropped: input typed (or piped) while a turn is
  // running becomes the next turn.
  const queue = []
  let busy = false
  let closing = false

  function finish() {
    resetCursor()
    console.log(dim('\nAkorith out. Your work stayed on your machine.'))
    process.exit(0)
  }

  async function pump() {
    if (busy) return
    busy = true
    while (queue.length) {
      const line = queue.shift()
      try {
        await handle(line)
      } catch (err) {
        console.error(red(err.message))
      }
    }
    busy = false
    if (closing) finish()
    rl.prompt()
  }

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl)
    process.stdin.on('keypress', (str, key = {}) => {
      // ctrl+t cycles reasoning visibility: hide → minimal → show → hide.
      // Works whether idle or mid-turn (applies to the next turn).
      if (key.name === 't' && key.ctrl) {
        if (awaitingModelPick) return
        const order = ['hide', 'minimal', 'show']
        const next = order[(order.indexOf(thinking) + 1) % order.length]
        thinking = next
        persist({ thinking })
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        console.log(faint('reasoning ') + violet(thinking))
        rl.prompt(true)
        return
      }
      if (awaitingModelPick) {
        if (key.name === 'up') {
          moveModelPicker(-1)
          return
        }
        if (key.name === 'down') {
          moveModelPicker(1)
          return
        }
        if (key.name === 'escape') {
          clearModelPicker()
          closeModelPicker()
          console.log(dim('Model switch cancelled.'))
          rl.prompt()
          return
        }
      }
      if (awaitingSessionPick) {
        if (key.name === 'up') { moveSessionPicker(-1); return }
        if (key.name === 'down') { moveSessionPicker(1); return }
        if (key.name === 'escape' || (key.name === 'q' && !key.ctrl)) {
          clearSessionPicker()
          closeSessionPicker()
          console.log(dim('Session picker cancelled.'))
          rl.prompt()
          return
        }
        if (key.name === 'return') { resumeSessionPick(); return }
        if (key.name === 'r' && key.ctrl) { renameSessionPick(); return }
        if (key.name === 'd' && key.ctrl) { deleteSessionPick(); return }
        if (key.name === 'e' && !key.ctrl) { exportSessionPick(); return }
        return // swallow other keys while the picker is open
      }
      // Command palette (ctrl+p). Printable chars build `rl.line` (readline's
      // own line editor owns them); we only intercept non-printable keys here.
      // The submitted line is resolved as a fuzzy query in handlePaletteInput.
      if (awaitingPalette) {
        if (key.name === 'up') { movePalette(-1); return }
        if (key.name === 'down') { movePalette(1); return }
        if (key.name === 'escape') {
          clearPalette()
          closePalette()
          console.log(dim('Palette cancelled.'))
          rl.line = ''
          rl.cursor = 0
          rl.prompt(true)
          return
        }
        if (key.name === 'return') { runPalette(); return }
        // let printable chars fall through to readline's line editor
        return
      }
      // Interactive review browser.
      if (awaitingReview) {
        if (reviewFiltering) {
          handleReviewFilterKey(str, key)
          return
        }
        if (key.name === 'up') { moveReview(-1); return }
        if (key.name === 'down') { moveReview(1); return }
        if (key.name === 'escape' || (key.name === 'q' && !key.ctrl)) { clearReview(); closeReview(); console.log(dim('Review browser closed.')); rl.prompt(true); return }
        if (str === '/' || key.name === '/') { reviewFiltering = true; redrawReview(); return }
        if (key.name === 'c' && !key.ctrl) { setReviewFilter(''); return }
        if (key.name === 'return' || key.name === 'right' || key.name === 'space') { toggleReview(); return }
        if (key.name === 'left' || key.name === 'backspace') { reviewExpanded.delete(reviewKey(reviewFiles[reviewSelected])); redrawReview(); return }
        if (key.name === 'n') { moveReview(1); return }
        if (key.name === 'p') { moveReview(-1); return }
        if (key.name === 'a' && key.shift) { reviewExpanded = new Set(); redrawReview(); return }
        if (key.name === 'a') { reviewFiles.forEach((file) => reviewExpanded.add(reviewKey(file))); redrawReview(); return }
        if (key.name === 'r' && !key.ctrl) { void reviewFile(); return }
        return
      }
      // ctrl+p opens the palette.
      if (key.name === 'p' && key.ctrl) {
        showPalette()
        return
      }
      if (!(key.name === 'm' && key.meta)) return
      if (activeChild || busy || closing || awaitingModelPick) return
      if (rl.line) {
        process.stdout.write('\x07')
        return
      }
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
      queue.push('/model')
      void pump()
    })
  }

  rl.on('line', (line) => {
    rewriteSubmittedLine(line)
    queue.push(line)
    void pump()
  })

  rl.on('SIGINT', () => {
    if (activeChild) {
      activeChild.kill('SIGINT')
      console.log(dim('\n(turn cancelled)'))
      return
    }
    const now = Date.now()
    if (now - lastSigint < 1500) {
      rl.close()
      return
    }
    lastSigint = now
    console.log(dim('\n(press Ctrl+C again to exit, or /exit)'))
    rl.prompt()
  })

  rl.on('close', () => {
    closing = true
    if (!busy) finish()
  })

  // Live reflow on resize: while idle redraw the status row; while the model
  // picker is open, repaint it so column-driven widths stay aligned. During a
  // turn the pinned spinner handles its own wrap on its next redraw, so we
  // don't touch the running transcript.
  function onResize() {
    if (awaitingModelPick) {
      redrawModelPicker()
      return
    }
    if (awaitingSessionPick) {
      redrawSessionPicker()
      return
    }
    if (awaitingPalette) {
      redrawPalette()
      return
    }
    if (awaitingReview) {
      redrawReview()
      return
    }
    if (activeChild || busy || closing) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    printStatus()
    rl.prompt(true)
  }
  process.stdout.on('resize', onResize)

  rl.prompt()
}
