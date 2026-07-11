import * as readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import * as os from 'node:os'
import {
  PROVIDERS, MODES, CONNECTIONS, detectProviders, parseModelSpec, formatModel, runTurn,
  connectionStatus, loadConnections, saveConnections,
} from './providers.js'
import {
  rule, bold, dim, faint, text, violet, green, red, yellow,
  diffAdd, diffDel, tintCursor, resetCursor, fitText, padVisible, pixelLogoLines,
  panelLines, setTerminalAdapter, stripAnsi, userMessageLines, visibleLength, wrapWords,
} from './ui.js'
import { loadConfig, saveConfig, homeRelative } from './state.js'
import {
  archiveSession, createSession, deleteSession, exportSession, findSession, forkSession, listSessions,
  recordSessionTranscript, recordTurn, renameSession, touchSession,
} from './sessions.js'
import { runDoctorCommand, runReviewCommand, runUpdateCommand, buildReviewPatch } from './commands.js'
import { COMMAND_CATALOG, filterCatalog, fuzzyMatch } from './palette.js'
import { filePatch, parseDiff } from './review.js'
import { InputEditor, ScreenInputAdapter } from './input-editor.js'
import { decodeTerminalMouseInput, TerminalScreen } from './terminal-screen.js'
import { loadCodexModels, modelSelectionSpec, normalizeModelSelection } from './models.js'

const STATIC_MODEL_CHOICES = [
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
let cachedCodexModels = null

function terminalColumns() {
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 88)
  return Math.max(20, Math.min(Number.isFinite(columns) ? columns : 88, 120))
}

function elideMiddle(value, max) {
  if (value.length <= max) return value
  if (max <= 8) return value.slice(0, max)
  const head = Math.ceil((max - 1) * 0.45)
  const tail = Math.floor((max - 1) * 0.55)
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function rawTerminalColumns() {
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 88)
  return Math.max(20, Number.isFinite(columns) ? columns : 88)
}

function displayLength(value) {
  return visibleLength(value)
}

function wrapSubmittedInput(input, width) {
  return wrapWords(input, width)
}

function formatUsageCount(value) {
  return (Number(value) || 0).toLocaleString('en-US')
}

function clockLabel(date = new Date()) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function contextWindowFor(selection) {
  const provider = selection?.provider || ''
  const model = String(selection?.model || '').toLowerCase()
  if (provider === 'claude') return '200k'
  if (provider === 'ollama' && /llama3\.2/.test(model)) return '128k'
  if (provider === 'codex' && /gpt-5|gpt-5\.5/.test(model)) return 'provider'
  return 'provider'
}

function compactModelStatus(selection) {
  const provider = selection?.provider || 'model'
  const model = selection?.model || 'default'
  return `model ${model === 'default' ? `${provider}/default` : model}`
}

function mergeUsageTotals(totals, usage = {}) {
  const input = Number(usage.input) || 0
  const output = Number(usage.output) || 0
  const total = Number(usage.total) || (input + output)
  totals.input += input
  totals.output += output
  totals.total += total
}

function rewriteSubmittedLine(line, promptText = text(bold('❯ '))) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return
  const columns = rawTerminalColumns()
  const promptWidth = Math.max(2, displayLength(stripAnsi(promptText)))
  if (displayLength(line) + promptWidth <= columns) return
  const rows = Math.max(1, Math.ceil((displayLength(line) + promptWidth) / columns))
  readline.moveCursor(process.stdout, 0, -rows)
  readline.clearScreenDown(process.stdout)
  const chunks = wrapSubmittedInput(line, Math.max(18, columns - promptWidth))
  chunks.forEach((chunk, index) => {
    const prefix = index === 0 ? promptText : faint(' '.repeat(promptWidth))
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

function codexChoices() {
  if (!cachedCodexModels) {
    cachedCodexModels = loadCodexModels()
    if (!cachedCodexModels.length) {
      cachedCodexModels = [
        { slug: 'gpt-5.5', displayName: 'GPT-5.5', reasoningEfforts: ['high'], defaultReasoningEffort: 'medium' },
        { slug: 'gpt-5.4', displayName: 'GPT-5.4', reasoningEfforts: ['high'], defaultReasoningEffort: 'medium' },
        { slug: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', reasoningEfforts: ['high'], defaultReasoningEffort: 'medium' },
      ]
    }
  }
  return cachedCodexModels.map((model) => {
    const reasoningEffort = model.reasoningEfforts.includes('high') ? 'high' : model.defaultReasoningEffort
    const parsed = normalizeModelSelection({ provider: 'codex', model: model.slug, reasoningEffort })
    const effortLabel = reasoningEffort ? ` ${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)}` : ''
    const spec = modelSelectionSpec(parsed)
    return {
      label: `Olympus · ${model.displayName}${effortLabel}`,
      spec,
      visibleSpec: spec,
      parsed,
      aliases: [model.slug, model.displayName, `${model.displayName}${effortLabel}`, `${model.slug}${reasoningEffort ? `-${reasoningEffort}` : ''}`],
    }
  })
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

export function resolveModelSpec(input, choices = []) {
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
  '/review', '/timeline', '/doctor', '/update', '/cd', '/new', '/clear', '/exit', '/quit',
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

function readGitHeaderState(cwd) {
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', timeout: 1000 })
  if (branch.status !== 0) return { branch: '', dirty: false }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 1000 })
  return {
    branch: String(branch.stdout || '').trim(),
    dirty: status.status === 0 && Boolean(String(status.stdout || '').trim()),
  }
}

export function shouldUseFullScreen({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  return env.AKORITH_NO_FULLSCREEN !== '1' &&
    Boolean(input.isTTY) && Boolean(output.isTTY) && env.TERM !== 'dumb'
}

export function nativeSplashLines({
  width = 80,
  cwd = '~',
  model = 'default',
  mode = 'act',
  tip = null,
} = {}) {
  const safeWidth = Math.max(20, Number(width) || 80)
  const center = (line) => `${' '.repeat(Math.max(0, Math.floor((safeWidth - visibleLength(line)) / 2)))}${line}`
  const logoRows = pixelLogoLines(safeWidth, safeWidth >= 72 ? 6 : 3).map(center)
  const rows = [
    '',
    ...logoRows,
    '',
    `${violet(bold('new session'))} ${dim('● ready')}`,
    dim(`${cwd} · ${model} · ${mode}`),
    '',
    yellow(bold('Your agent workspace is ready.')),
    `${violet('›')} ${text(bold('Start typing to begin'))}`,
    faint('/help · /model · /sessions · /review'),
  ]
  if (tip) rows.push('', `${text(bold('Tip:'))} ${dim(fitText(tip, Math.max(20, safeWidth - 8)))}`)
  rows.push('')
  return rows.map((line) => fitText(line, safeWidth))
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
    const parsed = normalizeModelSelection(typeof spec === 'string' ? resolveModelSpec(spec) : spec)
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
  let sessionPickerJustOpened = false
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
  let rl = null
  let splashActive = false
  let promptBoxActive = false
  let promptBoxPreludeRows = 0
  const usageTotals = { input: 0, output: 0, total: 0 }
  const queue = []
  let busy = false
  let closing = false
  let terminalScreen = null
  let gitHeader = readGitHeaderState(process.cwd())
  let chordUntil = 0
  let pendingMouseSequence = ''
  let pasteNoticeTimer = null

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
    if (session.selection && available[session.selection.provider]) selection = normalizeModelSelection(session.selection)
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

  function completionCandidates(line) {
    if (line.startsWith('/model ')) {
      const partial = line.slice(7)
      const specs = Object.keys(PROVIDERS).filter((id) => available[id])
      return specs.filter((spec) => spec.startsWith(partial)).map((spec) => '/model ' + spec)
    }
    if (line.startsWith('/')) {
      const hits = COMMANDS.filter((command) => command.startsWith(line))
      return hits.length ? hits : COMMANDS
    }
    return []
  }

  function completeEditor(line) {
    const candidates = completionCandidates(line)
    if (!candidates.length) return null
    if (candidates.length === 1) return { value: candidates[0] + (candidates[0].includes(' ') ? '' : ' '), candidates }
    let prefix = candidates[0]
    for (const candidate of candidates.slice(1)) {
      while (prefix && !candidate.startsWith(prefix)) prefix = prefix.slice(0, -1)
    }
    return { value: prefix.length > line.length ? prefix : line, candidates }
  }

  const nativeConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    clear: console.clear.bind(console),
  }
  // Interactive TTY sessions default to the responsive dashboard: a stable
  // header, transcript pane, sidebar on wide screens, and bottom composer.
  // AKORITH_NO_FULLSCREEN=1 keeps the plain native scrollback fallback.
  const useFullScreen = shouldUseFullScreen()
  if (useFullScreen) {
    const editor = new InputEditor({ complete: completeEditor })
    terminalScreen = new TerminalScreen({
      state: () => ({
        version,
        model: formatModel(selection),
        mode,
        cwd: homeRelative(process.cwd()),
        branch: gitHeader.branch,
        dirty: gitHeader.dirty,
        session: activeSession ? `${activeSession.name || activeSession.id} · #${activeSession.turns || 0}` : 'new session',
        busy: Boolean(activeChild || busy),
        connected: Boolean(available[selection.provider]),
        input: rl?.line || '',
        cursor: rl?.cursor || 0,
        usage: `${formatUsageCount(usageTotals.total)} tokens`,
        usageTotal: usageTotals.total,
        context: contextWindowFor(selection),
        queue: queue.length,
        composerLabel: rl?.questionCallback ? fitText(stripAnsi(rl.getPrompt()), 28) : 'Message',
      }),
    })
    rl = new ScreenInputAdapter({ editor, render: () => terminalScreen?.scheduleRender() })
    console.log = (...args) => terminalScreen.append(...args)
    console.error = (...args) => terminalScreen.append(red(args.map(String).join(' ')))
    console.clear = () => terminalScreen.clear()
    setTerminalAdapter(terminalScreen)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    terminalScreen.start()
  } else {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: currentPrompt(),
      completer(line) {
        return [completionCandidates(line), line]
      },
    })
  }

  let terminalRestored = false
  function restoreTerminal() {
    if (terminalRestored) return
    terminalRestored = true
    setTerminalAdapter(null)
    if (pasteNoticeTimer) clearTimeout(pasteNoticeTimer)
    process.stdin.setRawMode?.(false)
    terminalScreen?.stop()
    console.log = nativeConsole.log
    console.error = nativeConsole.error
    console.clear = nativeConsole.clear
  }

  function terminateFromSignal() {
    if (activeChild) activeChild.kill('SIGTERM')
    restoreTerminal()
    process.exit(0)
  }
  process.once('SIGTERM', terminateFromSignal)
  process.once('SIGHUP', terminateFromSignal)

  tintCursor()
  renderSplash({ tip: bootNotice ? stripAnsi(bootNotice) : null })

  function currentPrompt() {
    return text(bold('› '))
  }

  function refreshPrompt() {
    if (rl) rl.setPrompt(currentPrompt())
  }

  function promptNow(force = false) {
    refreshPrompt()
    rl.prompt(force)
  }

  function renderSplash({ tip = null } = {}) {
    splashActive = Boolean(terminalScreen)
    promptBoxActive = false
    refreshPrompt()
    if (terminalScreen) {
      terminalScreen.setOverlay(null)
      terminalScreen.clear()
      if (tip) terminalScreen.setNotice(dim(tip))
      terminalScreen.scheduleRender()
      return
    }
    for (const line of nativeSplashLines({
      width: terminalColumns(),
      cwd: homeRelative(process.cwd()),
      model: formatModel(selection),
      mode,
      tip,
    })) console.log(line)
  }

  function renderPromptBox() {
    if (!process.stdout.isTTY) return false
    if (terminalScreen) {
      promptBoxActive = true
      terminalScreen.scheduleRender()
      return true
    }
    return false
  }

  function clearPromptBox({ afterSubmit = false } = {}) {
    if (!process.stdout.isTTY || !promptBoxActive) return
    if (terminalScreen) {
      promptBoxActive = false
      terminalScreen.scheduleRender()
      return
    }
    readline.moveCursor(process.stdout, 0, -(promptBoxPreludeRows + (afterSubmit ? 1 : 0)))
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)
    promptBoxActive = false
    promptBoxPreludeRows = 0
  }

  function promptIdle() {
    refreshPrompt()
    if (terminalScreen) {
      terminalScreen.scheduleRender()
      return
    }
    if (awaitingModelPick || awaitingSessionPick || awaitingPalette || awaitingReview) {
      promptNow(true)
      return
    }
    if (!splashActive && renderPromptBox()) {
      promptNow(true)
      return
    }
    promptNow()
  }

  function promptIdleSoon() {
    setImmediate(promptIdle)
  }

  function connectMenu() {
    const status = connectionStatus()
    const rows = []
    for (const [id, c] of Object.entries(status)) {
      const dot = !c.ready ? red('✗') : c.on ? green('⚡') : faint('○')
      const state = !c.ready ? red('unavailable') : c.on ? green('on') : faint('off')
      rows.push(`${dot} ${text(bold(padVisible(c.label, 8)))} ${padVisible(state, 11)} ${faint(fitText(c.detail, Math.max(16, terminalColumns() - 34)))}`)
      rows.push(`${faint('  ' + fitText(c.note, Math.max(16, terminalColumns() - 10)))}`)
    }
    console.log()
    printPanelBlock({
      title: 'Connections',
      subtitle: 'external tools models can drive in act mode',
      lines: rows,
      footer: '/connect <name> on|off',
    })
    console.log()
  }

  function printStatus() {
    gitHeader = readGitHeaderState(process.cwd())
    refreshPrompt()
    terminalScreen?.scheduleRender()
  }

  function printPanelBlock(options) {
    for (const line of panelLines({ width: Math.min(terminalColumns(), 118), ...options })) console.log(line)
  }

  function printTurnHeader({ title, subtitle = '', prompt = '', footer = 'streaming output below' }) {
    const width = rawTerminalColumns()
    for (const line of userMessageLines({ prompt: prompt || title || '', width, timeLabel: clockLabel() })) {
      console.log(line)
    }
    const label = title === 'Review' ? 'Review' : title || (mode === 'act' ? 'Build' : 'Plan')
    console.log()
    console.log(faint('  ◆ ') + bold(label) + faint(' · ') + dim(fitText(subtitle || formatModel(selection), Math.max(18, width - 14), { middle: true })))
    console.log()
  }

  function printTurnFooter({ code, seconds, title = 'Turn complete' }) {
    const ok = code === 0
    const cancelled = code === 130
    if (ok) {
      console.log(faint('    ') + dim(`Turn completed in ${seconds}s.`))
      return
    }
    const status = cancelled ? yellow('Turn cancelled') : red(`Turn exited ${code}`)
    console.log(faint('    ') + status + faint(` in ${seconds}s.`))
  }

  function listModels() {
    const rows = []
    const width = Math.min(terminalColumns(), 118)
    const hintBudget = Math.max(18, width - 38)
    for (const p of Object.values(PROVIDERS)) {
      const status = available[p.id] ? green('ready') : red('not installed')
      const active = selection.provider === p.id ? violet('▸') : ' '
      rows.push(`${active} ${text(bold(padVisible(p.id, 9)))} ${violet(padVisible(p.codename, 9))} ${status}`)
      rows.push(`${faint('  ' + fitText(p.hint, hintBudget))}`)
    }
    console.log()
    printPanelBlock({
      title: 'Providers',
      subtitle: 'switch with /model <provider>[/<model>]',
      lines: rows,
      footer: '/model opens the picker',
    })
    console.log()
  }

  function modelSpec(selection_) {
    return modelSelectionSpec(selection_)
  }

  function isCurrentChoice(choice) {
    if (!choice.parsed) return false
    const current = normalizeModelSelection(selection)
    const candidate = normalizeModelSelection(choice.parsed)
    return candidate.provider === current.provider && candidate.model === current.model && candidate.reasoningEffort === current.reasoningEffort
  }

  function modelChoices() {
    const seen = new Set()
    const choices = [
      ...(available.codex ? codexChoices() : []),
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
    const width = Math.min(terminalColumns(), 118)
    const inner = width - 4
    const specWidth = Math.max(14, Math.min(34, inner - 38))
    const rows = []
    if (!modelPickChoices.length) {
      rows.push(red('No installed providers are available.'))
    }
    modelPickChoices.forEach((choice, index) => {
      const selected = index === modelPickSelected
      const current = isCurrentChoice(choice)
      const cursor = selected ? violet('▸') : faint(' ')
      const active = current ? green('●') : faint('○')
      const number = selected ? violet(String(index + 1).padStart(2)) : faint(String(index + 1).padStart(2))
      if (width < 56) {
        const summary = fitText(`${choice.label} · ${choice.visibleSpec || choice.spec}`, Math.max(8, inner - 8), { middle: true })
        rows.push(`${cursor} ${active} ${number} ${selected ? text(bold(summary)) : faint(summary)}`)
        return
      }
      const labelText = padVisible(fitText(choice.label, Math.max(18, inner - specWidth - 12), { middle: true }), Math.max(18, inner - specWidth - 12))
      const label = selected ? text(bold(labelText)) : text(labelText)
      const specText = choice.visibleSpec || choice.spec
      const spec = selected ? violet(fitText(specText, specWidth, { middle: true })) : faint(fitText(specText, specWidth, { middle: true }))
      rows.push(`${cursor} ${active} ${number} ${label} ${spec}`)
    })
    rows.push(faint('examples: gpt 5.5 high · fable 5 · opencode-go/glm-5.2'))
    return panelLines({
      title: 'Model picker',
      subtitle: '↑/↓ · enter',
      lines: rows,
      footer: 'enter selects · type alias/spec · q or esc cancels',
      width,
    })
  }

  function printModelPicker() {
    const lines = modelPickerLines()
    if (terminalScreen) {
      terminalScreen.setOverlay(lines)
      modelPickerRows = lines.length
      return
    }
    for (const line of lines) console.log(line)
    modelPickerRows = lines.length
  }

  function clearModelPicker() {
    if (!process.stdout.isTTY || !modelPickerRows) return
    if (terminalScreen) {
      terminalScreen.setOverlay(null)
      modelPickerRows = 0
      return
    }
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
    if (terminalScreen) terminalScreen.setOverlay(null)
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
    if (promptBoxActive) clearPromptBox()
    modelPickChoices = modelChoices()
    modelPickSelected = currentModelChoiceIndex(modelPickChoices)
    awaitingModelPick = true
    console.log()
    printModelPicker()
  }

  function applyModel(parsed) {
    const next = normalizeModelSelection(parsed)
    if (!available[next.provider]) {
      console.log(yellow(`${next.provider} CLI is not installed on this machine.`))
      return false
    }
    selection = next
    persist({ model: modelSpec(selection) })
    if (activeSession) activeSession = touchSession(activeSession.id, { selection }) || activeSession
    refreshPrompt()
    console.log(green('✓ ') + 'Now talking to ' + bold(formatModel(selection)))
    return true
  }

  // ── interactive session picker ───────────────────────────────────────
  // Mirrors the model picker: scroll with ↑/↓, enter resumes, ctrl+r renames,
  // ctrl+d deletes (with a y/n confirm), e exports a markdown transcript, q/esc
  // cancels. Triggered by `/sessions` with no args; `--all` lists every folder.
  function sessionPickerLines() {
    const width = Math.min(terminalColumns(), 118)
    const inner = width - 4
    const rows = []
    if (!sessionPickChoices.length) {
      rows.push(faint('No sessions yet. The first real prompt creates one.'))
    }
    const idBudget = terminalColumns() < 84 ? 10 : 14
    const modelBudget = terminalColumns() < 84 ? 18 : 24
    const promptBudget = Math.max(16, inner - idBudget - modelBudget - 12)
    sessionPickChoices.forEach((session, index) => {
      const selected = index === sessionPickSelected
      const active = activeSession?.id === session.id
      const cursor = selected ? violet('▸') : faint(' ')
      const mark = active ? green('●') : session.archived ? yellow('■') : faint('○')
      const num = selected ? violet(String(index + 1).padStart(2)) : faint(String(index + 1).padStart(2))
      if (width < 60) {
        const summary = fitText(session.name || session.id, Math.max(8, inner - 8), { middle: true })
        rows.push(`${cursor} ${mark} ${num} ${selected ? text(bold(summary)) : faint(summary)}`)
        return
      }
      const idText = padVisible(fitText(session.id, idBudget, { middle: true }), idBudget)
      const id = selected ? text(bold(idText)) : text(idText)
      const model = fitText(session.selection ? formatModel(session.selection) : 'unknown', modelBudget, { middle: true })
      const modelCell = selected ? violet(padVisible(model, modelBudget)) : faint(padVisible(model, modelBudget))
      const promptText = (session.lastPrompt || '(no turns yet)').replace(/\s+/g, ' ').trim()
      const promptCell = (selected ? text : faint)(fitText(promptText, promptBudget))
      rows.push(`${cursor} ${mark} ${num} ${id} ${modelCell} ${promptCell}`)
    })
    return panelLines({
      title: 'Sessions',
      subtitle: sessionPickAll ? 'all folders' : 'current folder',
      lines: rows,
      footer: 'enter resume · ctrl+r rename · ctrl+d delete · e export · q/esc',
      width,
    })
  }

  function printSessionPicker() {
    const lines = sessionPickerLines()
    if (terminalScreen) {
      terminalScreen.setOverlay(lines)
      sessionPickerRows = lines.length
      return
    }
    for (const line of lines) console.log(line)
    sessionPickerRows = lines.length
  }

  function clearSessionPicker() {
    if (!process.stdout.isTTY || !sessionPickerRows) return
    if (terminalScreen) {
      terminalScreen.setOverlay(null)
      sessionPickerRows = 0
      return
    }
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
    if (terminalScreen) terminalScreen.setOverlay(null)
    awaitingSessionPick = false
    sessionPickerRows = 0
    sessionPickChoices = []
    sessionPickSelected = 0
    sessionPickConfirm = null
    sessionPickerJustOpened = false
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
    if (promptBoxActive) clearPromptBox()
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
    sessionPickerJustOpened = true
    setImmediate(() => { sessionPickerJustOpened = false })
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
    const width = Math.min(terminalColumns(), 118)
    const inner = width - 4
    const rows = []
    if (!paletteChoices.length) {
      rows.push(red('No matching commands.'))
    }
    const cmdBudget = terminalColumns() < 78 ? 18 : 26
    const titleBudget = terminalColumns() < 78 ? 18 : 22
    const descBudget = Math.max(12, inner - cmdBudget - titleBudget - 8)
    paletteChoices.slice(0, 10).forEach((entry, index) => {
      const selected = index === paletteSelected
      const cursor = selected ? violet('▸') : faint(' ')
      if (width < 58) {
        const summary = fitText(`${entry.cmd} — ${entry.title}`, Math.max(8, inner - 4), { middle: true })
        rows.push(`${cursor} ${selected ? text(bold(summary)) : faint(summary)}`)
        return
      }
      const cmdText = padVisible(fitText(entry.cmd, cmdBudget, { middle: true }), cmdBudget)
      const titleText = padVisible(fitText(entry.title, titleBudget), titleBudget)
      const cmd = selected ? text(bold(cmdText)) : faint(cmdText)
      const title = (selected ? text : faint)(titleText)
      const desc = faint(fitText(entry.desc, descBudget))
      rows.push(`${cursor} ${cmd} ${title} ${desc}`)
    })
    if (paletteChoices.length > 10) rows.push(faint('… ' + (paletteChoices.length - 10) + ' more, narrow the query'))
    return panelLines({
      title: 'Command palette',
      subtitle: paletteQuery ? `filter ${paletteQuery}` : 'type to filter',
      lines: rows,
      footer: 'enter runs · esc/q cancels',
      width,
    })
  }

  function printPalette() {
    const lines = paletteLines()
    if (terminalScreen) {
      terminalScreen.setOverlay(lines)
      paletteRows = lines.length
      return
    }
    for (const line of lines) console.log(line)
    paletteRows = lines.length
  }

  function clearPalette() {
    if (!process.stdout.isTTY || !paletteRows) return
    if (terminalScreen) {
      terminalScreen.setOverlay(null)
      paletteRows = 0
      return
    }
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
    if (terminalScreen) terminalScreen.setOverlay(null)
    awaitingPalette = false
    paletteRows = 0
    paletteChoices = []
    paletteSelected = 0
    paletteQuery = ''
  }

  function showPalette() {
    if (activeChild || busy || closing || awaitingModelPick || awaitingSessionPick) return
    if (promptBoxActive) clearPromptBox()
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
    if (!terminalScreen) {
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)
    }
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
    const width = Math.min(terminalColumns(), 118)
    const inner = width - 4
    const count = reviewFilter
      ? `${reviewFiles.length}/${reviewAllFiles.length} files`
      : `${reviewFiles.length} file${reviewFiles.length === 1 ? '' : 's'}`
    const filter = reviewFilter || reviewFiltering
      ? `filter ${reviewFilter || ' '}`
      : ''
    const rows = []
    if (!reviewFiles.length) {
      rows.push(red('No files match this filter.'))
    }
    reviewFiles.forEach((f, index) => {
      const selected = index === reviewSelected
      const open = reviewExpanded.has(reviewKey(f))
      const cursor = selected ? violet('▸') : faint(' ')
      const mark = f.binary ? yellow('■') : open ? green('▾') : faint('▸')
      if (width < 58) {
        const countsText = f.binary ? 'binary' : `+${f.adds} -${f.dels}`
        const summary = fitText(`${f.path} ${countsText}`, Math.max(8, inner - 5), { middle: true })
        rows.push(`${cursor} ${mark} ${selected ? text(bold(summary)) : faint(summary)}`)
        return
      }
      const chip = f.summary === 'new file' ? green('created')
        : f.summary === 'deleted' ? red('deleted')
        : f.summary === 'renamed' ? violet('moved')
        : f.binary ? yellow('binary')
        : dim('patched')
      const countsText = f.binary ? '' : `+${f.adds} -${f.dels}`
      const pathBudget = Math.max(14, inner - visibleLength(stripAnsi(countsText)) - 18)
      const pathText = fitText(f.path, pathBudget, { middle: true })
      const path = selected ? text(bold(pathText)) : text(pathText)
      const counts = f.binary ? '' : faint('  ' + green('+' + f.adds) + ' ' + red('-' + f.dels))
      rows.push(`${cursor} ${mark} ${path} ${chip}${counts}`)
      if (open && !f.binary) {
        for (const hunk of f.hunks) {
          rows.push(faint('│ ' + fitText(hunk.header, inner - 2, { middle: true })))
          for (const l of hunk.lines) {
            const body = l.slice(1)
            if (/^\+/.test(l)) rows.push(diffAdd(body, inner))
            else if (/^-/.test(l)) rows.push(diffDel(body, inner))
            else if (/^ /.test(l)) rows.push(faint('│ ' + fitText(body, inner - 2, { middle: true })))
            else rows.push(faint('│ ' + fitText(l, inner - 2, { middle: true })))
          }
        }
      }
    })
    return panelLines({
      title: 'Review browser',
      subtitle: [count, filter].filter(Boolean).join(' · '),
      lines: rows,
      footer: reviewFiltering ? 'type filter · enter done · esc done · ctrl+u clear' : '/ filter · c clear · r review file · n/p next/prev · a all · q esc',
      width,
    })
  }

  function printReview() {
    const lines = reviewLines()
    if (terminalScreen) {
      terminalScreen.setOverlay(lines)
      reviewRows = lines.length
      return
    }
    for (const line of lines) console.log(line)
    reviewRows = lines.length
  }

  function clearReview() {
    if (!process.stdout.isTTY || !reviewRows) return
    if (terminalScreen) {
      terminalScreen.setOverlay(null)
      reviewRows = 0
      return
    }
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
    if (terminalScreen) terminalScreen.setOverlay(null)
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
    printTurnHeader({
      title: 'Review file',
      subtitle: formatModel(selection),
      prompt,
      footer: fitText(f.path, Math.max(18, terminalColumns() - 12), { middle: true }),
    })
    const startedAt = Date.now()
    const code = await runReviewCommand(
      { selection, mode: 'view', cwd: process.cwd(), options: turnOptions, review },
      { onSpawn: (child) => (activeChild = child) },
    )
    activeChild = null
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    printTurnFooter({ code, seconds, title: 'Review complete' })
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
    if (activeChild || closing || awaitingModelPick || awaitingSessionPick || awaitingPalette) return
    if (promptBoxActive) clearPromptBox()
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

  function printOptions() {
    const width = Math.min(terminalColumns(), 118)
    const valueBudget = Math.max(18, width - 24)
    const rows = [
      `${violet(padVisible('search', 14))} ${formatBool(turnOptions.search)}`,
      `${violet(padVisible('json', 14))} ${formatBool(turnOptions.json)}`,
      `${violet(padVisible('sandbox', 14))} ${faint(turnOptions.sandbox || (mode === 'act' ? 'workspace-write' : 'read-only'))}`,
      `${violet(padVisible('approval', 14))} ${faint(turnOptions.approval || 'provider default')}`,
    ]
    const addRow = (label, value) => {
      if (value) rows.push(`${violet(padVisible(label, 14))} ${faint(fitText(value, valueBudget, { middle: true }))}`)
    }
    const addList = (label, values) => {
      if (values?.length) addRow(label, values.join(' · '))
    }
    addRow('profile', turnOptions.profile)
    addRow('output', turnOptions.outputFile)
    addRow('schema', turnOptions.outputSchema)
    addRow('local', turnOptions.localProvider)
    addList('images', turnOptions.images)
    addList('add-dirs', turnOptions.addDirs)
    addList('configs', turnOptions.configs)
    addList('enable', turnOptions.enableFeatures)
    addList('disable', turnOptions.disableFeatures)
    console.log()
    printPanelBlock({
      title: 'Run options',
      subtitle: 'future model turns',
      lines: rows,
      footer: '/option search on · /option image ./shot.png · /option sandbox read-only',
    })
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
    clearModelPicker()
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
    const width = Math.min(terminalColumns(), 118)
    const cmdBudget = terminalColumns() < 76 ? 16 : 18
    const descBudget = Math.max(20, width - cmdBudget - 10)
    const command = (cmd, desc) => `${violet(padVisible(cmd, cmdBudget))} ${faint(fitText(desc, descBudget))}`
    const rows = [
      command('/model', 'open model picker, also via Alt+M when your terminal sends it'),
      command('/model <spec>', 'switch directly, e.g. /model gpt 5.5 high or /model claude/sonnet'),
      command('/models', 'list providers and how to address their models'),
      command('/mode <m>', 'view read-only or act can edit files, default act'),
      command('/thinking <m>', 'hide, minimal, show; ctrl+t cycles reasoning visibility'),
      command('/options', 'inspect run options: images, add-dir, json, search, sandbox'),
      command('/option <k> <v>', 'set a run option, e.g. /option image ./shot.png'),
      command('/sessions', 'browse saved Akorith sessions for this folder'),
      command('/resume --last', 'resume a saved session'),
      command('/fork <id>', 'fork a session into a fresh branch of work'),
      command('/review', 'browse and review the current diff file by file'),
      command('/timeline', 'browse, search, and jump through transcript rows'),
      command('/doctor', 'diagnose local CLIs, auth helpers, and global install'),
      command('/connect', 'show and toggle GitHub, git, npm integrations'),
      command('/cd <dir>', 'change the active working directory'),
      command('/new', 'start fresh conversations for all providers'),
      command('/clear', 'redraw the Grok Build-style start screen'),
      command('/exit', 'leave Akorith'),
      command('!<command>', 'run a shell command in place, e.g. !git status'),
    ]
    console.log()
    printPanelBlock({
      title: 'Commands',
      subtitle: 'Akorith workspace',
      lines: rows,
      footer: '/help reopens this reference',
    })
    const shortcut = (keys, desc) => `${violet(padVisible(keys, cmdBudget))} ${faint(fitText(desc, descBudget))}`
    printPanelBlock({
      title: 'Keyboard',
      subtitle: 'shown here instead of below the composer',
      lines: [
        shortcut('Enter', 'send the current prompt'),
        shortcut('Shift+Enter', 'insert a newline; Ctrl+J works everywhere'),
        shortcut('Ctrl+P', 'open the searchable command palette'),
        shortcut('Alt+M', 'open the model picker when supported by the terminal'),
        shortcut('↑ / ↓', 'move picker selection or recall prompt history'),
        shortcut('Wheel / PgUp', 'scroll transcript; wheel down or PageDown returns'),
        shortcut('Ctrl+X, G', 'open the transcript timeline'),
        shortcut('Ctrl+T', 'cycle reasoning visibility'),
        shortcut('Ctrl+C', 'cancel a turn; press twice while idle to exit'),
        shortcut('Esc', 'close the active picker or overlay'),
      ],
      footer: 'Composer stays clean; shortcuts live in /help',
    })
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

    if (terminalScreen?.overlay && !input.startsWith('/timeline')) terminalScreen.setOverlay(null)

    if (input === '/exit' || input === '/quit') {
      queue.length = 0
      rl.close()
      return
    }
    if (input === '/clear') {
      renderSplash()
      return
    }
    if (input === '/timeline' || input.startsWith('/timeline ')) {
      const rest = input.slice(9).trim()
      if (!terminalScreen) {
        console.log(dim('Timeline browsing is available in an interactive TTY.'))
        return
      }
      if (!rest) {
        terminalScreen.setOverlay(terminalScreen.timelineLines())
        terminalScreen.setNotice(dim('Use /timeline <row>, /timeline search <text>, or /timeline tail.'))
        return
      }
      if (rest === 'tail') {
        terminalScreen.transcriptOffset = 0
        terminalScreen.setOverlay(null)
        terminalScreen.setNotice('')
        return
      }
      if (rest.startsWith('search ')) {
        terminalScreen.setOverlay(null)
        terminalScreen.searchTranscript(rest.slice(7).trim())
        return
      }
      if (/^\d+$/.test(rest)) {
        terminalScreen.jumpTo(Number(rest) - 1)
        return
      }
      terminalScreen.setNotice(red('Usage: /timeline <row|tail|search text>'))
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
      const code = runUpdateCommand({ onOutput: terminalScreen ? (line) => terminalScreen.append(line) : null })
      console.log(code === 0 ? green('✓ Akorith updated to the latest available version.') : red('Akorith update failed.'))
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
      printTurnHeader({
        title: 'Review',
        subtitle: formatModel(selection),
        prompt: review.prompt || 'Review the selected diff.',
        footer: 'read-only review turn',
      })
      const startedAt = Date.now()
      const code = await runReviewCommand(
        { selection, mode: 'view', cwd: process.cwd(), options: turnOptions, review },
        { onSpawn: (child) => (activeChild = child) },
      )
      activeChild = null
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      printTurnFooter({ code, seconds, title: 'Review complete' })
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
      refreshPrompt()
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
      terminalScreen?.clearTodos()
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
        const child = spawn(cmd, {
          shell: true,
          stdio: terminalScreen ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        })
        activeChild = child
        if (terminalScreen) {
          child.stdout.on('data', (chunk) => terminalScreen.append(String(chunk).replace(/\s+$/, '')))
          child.stderr.on('data', (chunk) => terminalScreen.append(red(String(chunk).replace(/\s+$/, ''))))
        }
        child.on('exit', resolve)
        child.on('error', resolve)
      })
      activeChild = null
      return
    }

    // A real prompt — hand it to the active provider, streaming. The turn opens
    // and closes with the same panel chrome used by the rest of the workspace.
    const session = ensureActiveSession()
    console.log()
    printTurnHeader({
      title: mode === 'act' ? 'Build' : 'Plan',
      subtitle: formatModel(selection),
      prompt: input,
      footer: mode === 'act' ? 'edits and commands may run' : 'read-only turn',
    })
    const startedAt = Date.now()
    const transcriptBuf = []
    const code = await runTurn(
      { selection, prompt: input, resume: started[selection.provider], cwd: process.cwd(), mode, options: { ...turnOptions, thinking } },
      {
        onSpawn: (child) => (activeChild = child),
        onLine: (plain) => { if (plain.trim()) transcriptBuf.push(plain) },
        onUsage: (usage) => mergeUsageTotals(usageTotals, usage),
      },
    )
    activeChild = null
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    if (code === 0) started[selection.provider] = true
    printTurnFooter({ code, seconds })
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
  function finish() {
    resetCursor()
    if (terminalScreen) {
      restoreTerminal()
      terminalScreen = null
      nativeConsole.log(dim('Akorith out. Your work stayed on your machine.'))
    } else {
      console.log(dim('\nAkorith out. Your work stayed on your machine.'))
    }
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
    promptIdle()
  }

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, terminalScreen ? undefined : rl)
    process.stdin.on('keypress', (str, key = {}) => {
      const eventSequence = String(key.sequence || str || '')
      const decodedMouse = terminalScreen
        ? decodeTerminalMouseInput(pendingMouseSequence, eventSequence)
        : { buffer: '', event: null, captured: false }
      pendingMouseSequence = decodedMouse.buffer
      if (decodedMouse.captured && !decodedMouse.event) return
      const mouse = decodedMouse.event
      if (mouse) {
        if (mouse.type === 'wheel') {
          const selectionDelta = mouse.direction === 'up' ? -1 : 1
          if (awaitingModelPick) moveModelPicker(selectionDelta)
          else if (awaitingSessionPick) moveSessionPicker(selectionDelta)
          else if (awaitingPalette) movePalette(selectionDelta)
          else if (awaitingReview) moveReview(selectionDelta)
          else terminalScreen.scroll(-selectionDelta * 3)
        }
        return
      }
      // ctrl+t cycles reasoning visibility: hide → minimal → show → hide.
      // Works whether idle or mid-turn (applies to the next turn).
      if (key.name === 't' && key.ctrl) {
        if (awaitingModelPick) return
        const order = ['hide', 'minimal', 'show']
        const next = order[(order.indexOf(thinking) + 1) % order.length]
        thinking = next
        persist({ thinking })
        if (terminalScreen) {
          terminalScreen.setNotice(faint('reasoning ') + violet(thinking))
          terminalScreen.scheduleRender()
          return
        }
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
          rl.line = ''
          rl.cursor = 0
          promptIdleSoon()
          return
        }
        if ((key.name === 'q' || str === 'q') && !key.ctrl) {
          clearModelPicker()
          closeModelPicker()
          console.log(dim('Model switch cancelled.'))
          rl.line = ''
          rl.cursor = 0
          promptIdleSoon()
          return
        }
      }
      if (awaitingSessionPick) {
        if (key.name === 'up') { moveSessionPicker(-1); return }
        if (key.name === 'down') { moveSessionPicker(1); return }
        if (key.name === 'escape' || ((key.name === 'q' || str === 'q') && !key.ctrl)) {
          clearSessionPicker()
          closeSessionPicker()
          console.log(dim('Session picker cancelled.'))
          rl.line = ''
          rl.cursor = 0
          promptIdleSoon()
          return
        }
        if (key.name === 'return') {
          if (sessionPickerJustOpened) return
          resumeSessionPick()
          return
        }
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
        if (key.name === 'escape' || ((key.name === 'q' || str === 'q') && !key.ctrl)) {
          clearPalette()
          closePalette()
          console.log(dim('Palette cancelled.'))
          rl.line = ''
          rl.cursor = 0
          promptIdleSoon()
          return
        }
        if (key.name === 'return') { runPalette(); return }
        if (terminalScreen) {
          if (key.name === 'backspace') paletteQuery = paletteQuery.slice(0, -1)
          else if (key.name === 'u' && key.ctrl) paletteQuery = ''
          else if (str && str.length === 1 && !key.ctrl && !key.meta) paletteQuery += str
          else return
          paletteChoices = filterCatalog(paletteQuery)
          paletteSelected = 0
          redrawPalette()
          return
        }
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
        if (key.name === 'escape' || (key.name === 'q' && !key.ctrl)) { clearReview(); closeReview(); console.log(dim('Review browser closed.')); promptIdleSoon(); return }
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
      if (terminalScreen && key.name === 'x' && key.ctrl) {
        chordUntil = Date.now() + 1500
        terminalScreen.setNotice(faint('Ctrl+X … press G for timeline'))
        return
      }
      if (terminalScreen && Date.now() < chordUntil && (key.name === 'g' || str === 'g')) {
        chordUntil = 0
        terminalScreen.setOverlay(terminalScreen.timelineLines())
        terminalScreen.setNotice(dim('Timeline open · type /timeline <row|tail|search text>.'))
        return
      }
      if (terminalScreen && key.name === 'pageup') {
        terminalScreen.scroll(Math.max(1, terminalScreen.dimensions().height - 8))
        return
      }
      if (terminalScreen && key.name === 'pagedown') {
        terminalScreen.scroll(-Math.max(1, terminalScreen.dimensions().height - 8))
        return
      }
      if (key.name === 'm' && key.meta) {
        if (activeChild || busy || closing || awaitingModelPick) return
        if (rl.line) {
          process.stdout.write('\x07')
          return
        }
        if (terminalScreen) {
          queue.push('/model')
          void pump()
          return
        }
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        queue.push('/model')
        void pump()
        return
      }
      if (!terminalScreen) return
      const action = rl.handleKeypress(str, key)
      if (action.type === 'submit') rl.submit(action.value)
      else if (action.type === 'palette') showPalette()
      else if (action.type === 'clear') renderSplash()
      else if (action.type === 'interrupt') rl.emit('SIGINT')
      else if (action.type === 'eof') rl.close()
      else if (action.type === 'escape' && rl.line) { rl.line = ''; rl.cursor = 0 }
      else if (action.type === 'bell') process.stdout.write('\x07')
      if (action.pasted) {
        const lines = String(str).split('\n').length
        terminalScreen.setNotice(green(`Pasted ${[...String(str)].length} characters${lines > 1 ? ` across ${lines} lines` : ''}.`))
        if (pasteNoticeTimer) clearTimeout(pasteNoticeTimer)
        pasteNoticeTimer = setTimeout(() => terminalScreen?.setNotice(''), 1800)
        pasteNoticeTimer.unref?.()
      }
      terminalScreen.scheduleRender()
    })
  }

  rl.on('line', (line) => {
    if (splashActive) {
      splashActive = false
      promptBoxActive = false
      if (terminalScreen) {
        terminalScreen.setNotice('')
        terminalScreen.clear()
      }
    } else if (promptBoxActive) {
      clearPromptBox({ afterSubmit: true })
    } else {
      rewriteSubmittedLine(line, rl.getPrompt())
    }
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

  // Live reflow on resize: repaint active overlays and the Grok-style splash
  // screen in place. During a turn the pinned spinner owns the active line.
  function onResize() {
    if (terminalScreen) {
      if (awaitingModelPick) printModelPicker()
      else if (awaitingSessionPick) printSessionPicker()
      else if (awaitingPalette) printPalette()
      else if (awaitingReview) printReview()
      else terminalScreen.renderNow()
      return
    }
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
    if (splashActive) {
      renderSplash()
      promptNow(true)
      return
    }
    if (promptBoxActive) {
      clearPromptBox()
      promptIdle()
      return
    }
    promptIdle()
  }
  process.stdout.on('resize', onResize)

  promptNow()
}
