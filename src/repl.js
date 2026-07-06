import * as readline from 'node:readline'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  PROVIDERS, MODES, CONNECTIONS, detectProviders, parseModelSpec, formatModel, runTurn,
  connectionStatus, loadConnections, saveConnections,
} from './providers.js'
import { animateBanner, rule, bold, dim, faint, text, violet, green, red, yellow, tintCursor, resetCursor } from './ui.js'

const CONFIG_DIR = path.join(os.homedir(), '.akorith')
const CONFIG_FILE = path.join(CONFIG_DIR, 'cli.json')

const MODEL_PRESETS = [
  { label: 'Olympus · default', spec: 'codex', detail: 'Codex CLI default model' },
  { label: 'Olympus · GPT-5 Codex', spec: 'codex/gpt-5-codex', aliases: ['gpt 5 codex', 'gpt-5 codex'] },
  { label: 'Olympus · GPT-5.5 High', spec: 'codex/gpt-5.5-high', aliases: ['gpt 5.5 high', 'gpt-5.5-high'] },
  { label: 'Olympus · GPT-5 High', spec: 'codex/gpt-5-high', aliases: ['gpt 5 high', 'gpt-5-high'] },
  { label: 'Atlantis · default', spec: 'claude', detail: 'Claude CLI default model' },
  { label: 'Atlantis · Opus', spec: 'claude/opus', aliases: ['opus'] },
  { label: 'Atlantis · Sonnet', spec: 'claude/sonnet', aliases: ['sonnet'] },
  { label: 'Atlantis · Haiku', spec: 'claude/haiku', aliases: ['haiku'] },
  { label: 'Gaia · default', spec: 'opencode', detail: 'OpenCode default model' },
  { label: 'Gaia · Fable 5 High', spec: 'opencode/fable-5-high', aliases: ['fable 5 high', 'fable-5-high'] },
  {
    label: 'Gaia · Claude Sonnet 4.5',
    spec: 'opencode/anthropic/claude-sonnet-4-5',
    aliases: ['claude sonnet 4.5', 'sonnet 4.5'],
  },
  { label: 'Local · llama3.2', spec: 'ollama/llama3.2', aliases: ['llama', 'llama3.2'] },
]

const MODEL_ALIAS_MAP = new Map(
  MODEL_PRESETS.flatMap((preset) =>
    [preset.label, preset.spec, ...(preset.aliases || [])].map((alias) => [normalizeModelAlias(alias), preset.spec]),
  ),
)

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

function normalizeModelAlias(value) {
  return String(value)
    .toLowerCase()
    .replace(/[._/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveModelSpec(input) {
  const raw = input.trim()
  if (!raw) return null
  return parseModelSpec(MODEL_ALIAS_MAP.get(normalizeModelAlias(raw)) || raw)
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(config) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
  } catch {
    // config persistence is best-effort
  }
}

const COMMANDS = ['/help', '/models', '/model', '/mode', '/connect', '/new', '/clear', '/exit', '/quit']

export async function startRepl({ version, initialModel }) {
  const config = loadConfig()
  const available = detectProviders()

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

  // One conversation thread per provider; resume flags only make sense after
  // the first turn of that provider in this Akorith session.
  const started = { claude: false, codex: false, opencode: false, ollama: false }
  let activeChild = null
  let awaitingModelPick = false
  let modelPickChoices = []
  let modelPickSelected = 0
  let modelPickerRows = 0
  let lastSigint = 0

  console.clear()
  tintCursor()
  await animateBanner(version)
  console.log()
  printStatus()
  printConnections()
  printHint()
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
    const cwd = process.cwd().replace(os.homedir(), '~')
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

  function isCurrentModel(spec) {
    const parsed = parseModelSpec(spec)
    return parsed && parsed.provider === selection.provider && parsed.model === selection.model
  }

  function modelChoices() {
    const seen = new Set()
    return MODEL_PRESETS
      .map((preset) => ({ ...preset, parsed: parseModelSpec(preset.spec) }))
      .filter(({ parsed, spec }) => {
        if (!parsed || !available[parsed.provider] || seen.has(spec)) return false
        seen.add(spec)
        return true
      })
  }

  function currentModelChoiceIndex(choices) {
    const index = choices.findIndex((choice) => isCurrentModel(choice.spec))
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
      const current = isCurrentModel(choice.spec)
      const cursor = selected ? violet('▸') : faint(' ')
      const active = current ? green('●') : faint('○')
      const number = selected ? violet(String(index + 1).padStart(2)) : faint(String(index + 1).padStart(2))
      const label = selected ? text(bold(choice.label.padEnd(28))) : text(choice.label.padEnd(28))
      const spec = selected ? violet(elideMiddle(choice.spec, specWidth)) : faint(elideMiddle(choice.spec, specWidth))
      lines.push(`  ${cursor} ${active} ${number} ${label} ${spec}`)
    })
    lines.push(rule('enter selects · type alias/spec · q or esc cancels', dim, '╰'))
    lines.push(faint('examples: gpt 5.5 high · fable 5 high · codex/gpt-5-codex'))
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
    saveConfig({ ...config, model: modelSpec(selection) })
    console.log(green('✓ ') + 'Now talking to ' + bold(formatModel(selection)))
    return true
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
    const parsed = selected ? selected.parsed : resolveModelSpec(value)
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
    console.log(`  ${violet('/connect')}        show & toggle GitHub, git, npm integrations`)
    console.log(`  ${violet('/new')}            start fresh conversations (all providers)`)
    console.log(`  ${violet('/clear')}          clear the screen`)
    console.log(`  ${violet('/exit')}           leave Akorith`)
    console.log(`  ${violet('!<command>')}      run a shell command in place (e.g. !git status)`)
    console.log()
    console.log(dim('Anything else is sent to the active model. Conversations continue per'))
    console.log(dim('provider until /new. Ctrl+C cancels a running turn; twice exits.'))
    console.log()
  }

  async function handle(line) {
    const input = line.trim()
    if (awaitingModelPick) {
      handleModelPickerInput(input)
      return
    }
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
      saveConfig({ ...config, mode })
      console.log(green('✓ ') + 'Mode set to ' + bold(mode) + ' ' + faint('— ' + MODES[mode]))
      return
    }
    if (input === '/new') {
      for (const key of Object.keys(started)) started[key] = false
      console.log(dim('Fresh start — the next message opens a new conversation.'))
      return
    }
    if (input.startsWith('/model')) {
      const spec = input.slice(6).trim()
      if (!spec) {
        showModelPicker()
        return
      }
      const parsed = resolveModelSpec(spec)
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
          process.chdir(target.replace(/^~(?=$|\/)/, os.homedir()))
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
    console.log()
    console.log(rule(`${formatModel(selection)} · ${mode}`, violet, '╭'))
    const startedAt = Date.now()
    const code = await runTurn(
      { selection, prompt: input, resume: started[selection.provider], cwd: process.cwd(), mode },
      { onSpawn: (child) => (activeChild = child) },
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
    process.stdin.on('keypress', (_str, key = {}) => {
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

  rl.prompt()
}
