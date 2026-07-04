import * as readline from 'node:readline'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { PROVIDERS, detectProviders, parseModelSpec, formatModel, runTurn } from './providers.js'
import { banner, rule, bold, dim, faint, text, violet, green, red, yellow, tintCursor, resetCursor } from './ui.js'

const CONFIG_DIR = path.join(os.homedir(), '.akorith')
const CONFIG_FILE = path.join(CONFIG_DIR, 'cli.json')

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

const COMMANDS = ['/help', '/models', '/model', '/new', '/clear', '/exit', '/quit']

export function startRepl({ version, initialModel }) {
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

  // One conversation thread per provider; resume flags only make sense after
  // the first turn of that provider in this Akorith session.
  const started = { claude: false, codex: false, opencode: false, ollama: false }
  let activeChild = null
  let lastSigint = 0

  console.clear()
  tintCursor()
  console.log(banner(version))
  console.log()
  printStatus()
  console.log(dim('Type a task. /help for commands, /model to switch models, ! to run shell.'))
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

  function printStatus() {
    const parts = [
      green('●') + ' ' + dim(formatModel(selection)),
      faint(process.cwd().replace(os.homedir(), '~')),
      started[selection.provider] ? faint('session continues') : faint('new session'),
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

  function help() {
    console.log()
    console.log(text(bold('Commands')))
    console.log(`  ${violet('/model <spec>')}   switch model — e.g. /model claude/sonnet, /model codex`)
    console.log(`  ${violet('/models')}         list providers and how to address their models`)
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
    if (input === '/new') {
      for (const key of Object.keys(started)) started[key] = false
      console.log(dim('Fresh start — the next message opens a new conversation.'))
      return
    }
    if (input.startsWith('/model')) {
      const spec = input.slice(6).trim()
      if (!spec) {
        listModels()
        return
      }
      const parsed = parseModelSpec(spec)
      if (!parsed) {
        console.log(red('Unknown provider. ') + dim('Use one of: ' + Object.keys(PROVIDERS).join(', ')))
        return
      }
      if (!available[parsed.provider]) {
        console.log(yellow(`${parsed.provider} CLI is not installed on this machine.`))
        return
      }
      selection = parsed
      saveConfig({ ...config, model: `${selection.provider}${selection.model ? '/' + selection.model : ''}` })
      console.log(green('✓ ') + 'Now talking to ' + bold(formatModel(selection)))
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

    // A real prompt — hand it to the active provider, streaming.
    console.log(rule(formatModel(selection)))
    const startedAt = Date.now()
    const code = await runTurn(
      { selection, prompt: input, resume: started[selection.provider], cwd: process.cwd() },
      { onSpawn: (child) => (activeChild = child) },
    )
    activeChild = null
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    if (code === 0) {
      started[selection.provider] = true
      console.log(green(`✓ done in ${seconds}s`))
    } else if (code === 130) {
      console.log(yellow('■ cancelled'))
    } else {
      console.log(red(`✗ exited with code ${code}`))
    }
    console.log(rule())
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
