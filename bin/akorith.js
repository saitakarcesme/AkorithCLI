#!/usr/bin/env node
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { startRepl } from '../src/repl.js'
import { MODES, detectProviders, parseModelSpec, runTurn } from '../src/providers.js'
import {
  printSessions, runCodexPassthrough, runDoctorCommand, runReviewCommand, runSessionCommand, runUpdateCommand,
} from '../src/commands.js'
import { loadConfig } from '../src/state.js'
import { findSession, listSessions, recordTurn } from '../src/sessions.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const argv = process.argv.slice(2)

const CODEX_PASSTHROUGH = new Set([
  'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control',
  'app', 'completion', 'sandbox', 'debug', 'apply', 'cloud', 'exec-server', 'features', 'help',
])

function usage() {
  console.log(`akorith v${version} — the Agent OS for your terminal

Usage:
  akorith                              start the interactive workspace
  akorith <prompt>                     one-shot prompt, Codex-style
  akorith -p "<prompt>"                one-shot prompt, Akorith legacy shorthand
  akorith exec "<prompt>"              one-shot prompt, explicit
  akorith review [--uncommitted]       review a diff with the active model
  akorith sessions [--all]             list saved Akorith sessions
  akorith resume (--last|<id>)         resume a saved Akorith session
  akorith doctor                       diagnose local CLIs and global install
  akorith update                       fetch latest main and update the global akorith command
  akorith codex <command> ...          pass through to the Codex CLI

Common options:
  -m, --model <spec>                   provider/model, e.g. claude/sonnet or codex/gpt-5.5-high
  --mode <view|act>                    read-only or acting mode; default act
  -C, --cd <dir>                       set working directory
  --add-dir <dir>                      extra writable directory for supported providers
  -i, --image <file>                   attach image(s) to supported providers
  --search                             enable Codex web search
  --json, --output-schema <file>       structured Codex output
  -o, --output <file>                  write last response for supported providers
  -s, --sandbox <mode>                 read-only, workspace-write, or danger-full-access
  -a, --ask-for-approval <policy>      accepted for compatibility where providers support it
  -c, --config <key=value>             pass Codex config override(s)
  --version                            print version

Model specs: <provider>[/<model>] with provider one of claude, codex, opencode, ollama.
OpenCode exact ids also work as -m opencode-go/glm-5.2.
Inside the workspace: native terminal scrollback, an inline composer, /model to switch,
/timeline to browse saved output, /options for run flags, and /help for everything else.`)
}

function die(message) {
  console.error(message)
  usage()
  process.exit(1)
}

function expandPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=$|\/)/, os.homedir()))
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function makeOptions() {
  return { images: [], addDirs: [], configs: [], enableFeatures: [], disableFeatures: [] }
}

function consumeRunFlag(state, args, index) {
  const arg = args[index]
  const next = () => {
    if (index + 1 >= args.length) die(`Missing value for ${arg}`)
    return args[index + 1]
  }
  switch (arg) {
    case '--help':
    case '-h':
      state.help = true
      return index
    case '--model':
    case '-m':
      state.initialModel = next()
      return index + 1
    case '--prompt':
    case '-p':
      state.prompt = next()
      return index + 1
    case '--mode':
      state.mode = next()
      return index + 1
    case '--cd':
    case '-C':
      state.cwd = expandPath(next())
      return index + 1
    case '--add-dir':
      state.options.addDirs.push(expandPath(next()))
      return index + 1
    case '--image':
    case '-i':
      state.options.images.push(expandPath(next()))
      return index + 1
    case '--profile':
      state.options.profile = next()
      return index + 1
    case '--config':
    case '-c':
      state.options.configs.push(next())
      return index + 1
    case '--enable':
      state.options.enableFeatures.push(next())
      return index + 1
    case '--disable':
      state.options.disableFeatures.push(next())
      return index + 1
    case '--search':
      state.options.search = true
      return index
    case '--json':
      state.options.json = true
      return index
    case '--output-schema':
      state.options.outputSchema = expandPath(next())
      return index + 1
    case '--output':
    case '--output-last-message':
    case '-o':
      state.options.outputFile = expandPath(next())
      return index + 1
    case '--sandbox':
    case '-s':
      state.options.sandbox = next()
      return index + 1
    case '--approval':
    case '--ask-for-approval':
    case '-a':
      state.options.approval = next()
      return index + 1
    case '--oss':
      state.options.oss = true
      return index
    case '--local-provider':
      state.options.localProvider = next()
      return index + 1
    case '--strict-config':
      state.options.strictConfig = true
      return index
    case '--ephemeral':
      state.options.ephemeral = true
      return index
    case '--ignore-user-config':
      state.options.ignoreUserConfig = true
      return index
    case '--ignore-rules':
      state.options.ignoreRules = true
      return index
    case '--dangerously-bypass-approvals-and-sandbox':
      state.options.dangerBypass = true
      return index
    case '--dangerously-bypass-hook-trust':
      state.options.bypassHookTrust = true
      return index
    case '--color':
      state.options.color = next()
      return index + 1
    case '--session-id':
      state.options.sessionId = next()
      return index + 1
    case '--no-alt-screen':
      return index
    default:
      return null
  }
}

function parseRunArgs(args, { allowPrompt = true, extra = null } = {}) {
  const state = {
    initialModel: null,
    prompt: null,
    promptParts: [],
    mode: 'act',
    cwd: process.cwd(),
    options: makeOptions(),
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const extraIndex = extra?.(state, args, i)
    if (extraIndex !== null && extraIndex !== undefined) {
      i = extraIndex
      continue
    }
    const consumed = consumeRunFlag(state, args, i)
    if (consumed !== null) {
      i = consumed
      continue
    }
    if (arg === '--') {
      state.promptParts.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') die(`Unknown argument: ${arg}`)
    if (!allowPrompt) die(`Unexpected argument: ${arg}`)
    state.promptParts.push(...args.slice(i))
    break
  }
  if (state.prompt === null && state.promptParts.length) state.prompt = state.promptParts.join(' ')
  if (state.prompt === '-') state.prompt = readStdinIfPiped()
  const stdin = readStdinIfPiped()
  if (state.prompt !== null && state.prompt !== '' && stdin.trim()) {
    state.prompt += `\n\n<stdin>\n${stdin}\n</stdin>`
  } else if (state.prompt === null && stdin.trim()) {
    state.prompt = stdin
  }
  return state
}

function resolveModelSpec(spec) {
  if (!spec) return null
  if (/^(opencode|opencode-go)\/[A-Za-z0-9._-]+$/.test(spec)) {
    return { provider: 'opencode', model: spec }
  }
  return parseModelSpec(spec)
}

function selectionFrom(state) {
  const available = detectProviders()
  const config = loadConfig()
  let selection = state.initialModel ? resolveModelSpec(state.initialModel) : null
  if (!selection && config.model) selection = resolveModelSpec(config.model)
  if (!selection) {
    const fallback = ['claude', 'codex', 'opencode', 'ollama'].find((id) => available[id])
    selection = fallback ? { provider: fallback, model: null } : null
  }
  if (!selection || !available[selection.provider]) {
    console.error('No usable agent CLI found for this prompt.')
    process.exit(1)
  }
  if (!MODES[state.mode]) {
    console.error(`Invalid mode: ${state.mode} (expected ${Object.keys(MODES).join(' or ')})`)
    process.exit(1)
  }
  return selection
}

async function runPrompt(state) {
  if (state.help) {
    usage()
    return 0
  }
  process.chdir(state.cwd)
  if (state.prompt === null) {
    await startRepl({ version, initialModel: state.initialModel, initialOptions: state.options })
    // The interactive REPL took over — keep Node alive for the readline loop.
    return null
  }
  if (!String(state.prompt).trim()) {
    console.error('Empty prompt.')
    return 1
  }
  const selection = selectionFrom(state)
  return runTurn({ selection, prompt: state.prompt, resume: false, cwd: process.cwd(), mode: state.mode, options: state.options })
}

function parseReviewArgs(args) {
  const review = { uncommitted: false, base: null, commit: null, title: null, prompt: '' }
  const state = parseRunArgs(args, {
    extra(_state, values, index) {
      const arg = values[index]
      const next = () => {
        if (index + 1 >= values.length) die(`Missing value for ${arg}`)
        return values[index + 1]
      }
      if (arg === '--uncommitted') {
        review.uncommitted = true
        return index
      }
      if (arg === '--base') {
        review.base = next()
        return index + 1
      }
      if (arg === '--commit') {
        review.commit = next()
        return index + 1
      }
      if (arg === '--title') {
        review.title = next()
        return index + 1
      }
      return null
    },
  })
  review.prompt = state.prompt || ''
  return { state, review }
}

async function runReview(args) {
  const { state, review } = parseReviewArgs(args)
  if (state.help) {
    console.log('Usage: akorith review [--uncommitted] [--base <branch>] [--commit <sha>] [--title <title>] [prompt]')
    return 0
  }
  process.chdir(state.cwd)
  return runReviewCommand({ selection: selectionFrom(state), mode: 'view', cwd: process.cwd(), options: state.options, review })
}

async function runResume(args) {
  const state = {
    initialModel: null,
    mode: 'act',
    cwd: process.cwd(),
    options: makeOptions(),
    help: false,
    prompt: null,
    id: null,
    last: false,
    all: false,
    promptParts: [],
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const consumed = consumeRunFlag(state, args, i)
    if (consumed !== null) {
      i = consumed
      continue
    }
    if (arg === '--last') state.last = true
    else if (arg === '--all') state.all = true
    else if (arg.startsWith('-')) die(`Unknown argument: ${arg}`)
    else if (!state.id && !state.last) state.id = arg
    else {
      state.promptParts.push(...args.slice(i))
      break
    }
  }
  if (state.help) {
    console.log('Usage: akorith resume (--last|<session-id|name>) [prompt]')
    return 0
  }
  let session = state.id ? findSession(state.id) : null
  if (!session && state.last) session = listSessions({ all: state.all, cwd: state.all ? null : state.cwd })[0] || null
  if (!session) {
    console.error('Session not found. Use: akorith sessions --all')
    return 1
  }
  const prompt = state.prompt || state.promptParts.join(' ')
  if (!prompt) {
    await startRepl({
      version,
      initialModel: state.initialModel,
      initialOptions: state.options,
      initialSessionId: session.id,
    })
    // The interactive REPL took over — keep Node alive for the readline loop.
    return null
  }
  try {
    process.chdir(session.cwd || state.cwd)
  } catch {
    process.chdir(state.cwd)
  }
  const selection = state.initialModel ? selectionFrom(state) : (session.selection || selectionFrom(state))
  const mode = MODES[session.mode] ? session.mode : state.mode
  const code = await runTurn({
    selection,
    prompt,
    resume: Boolean(session.providerStarted?.[selection.provider]),
    cwd: process.cwd(),
    mode,
    options: state.options,
  })
  recordTurn(session.id, { selection, mode, provider: selection.provider, prompt, code })
  return code
}

async function main() {
  const command = argv[0]
  if (command === 'codex') return runCodexPassthrough(argv.slice(1))
  if (argv.length === 1 && (command === '--version' || command === '-v')) {
    console.log(version)
    return 0
  }
  if (!command || command.startsWith('-')) return runPrompt(parseRunArgs(argv))
  if (command === '--help' || command === '-h') {
    usage()
    return 0
  }
  if (command === 'exec' || command === 'e') {
    if (argv[1] === 'review') return runReview(argv.slice(2))
    if (argv[1] === 'resume') return runResume(argv.slice(2))
    return runPrompt(parseRunArgs(argv.slice(1)))
  }
  if (command === 'review') return runReview(argv.slice(1))
  if (command === 'doctor') return runDoctorCommand()
  if (command === 'update') return runUpdateCommand()
  if (command === 'sessions') return printSessions({ all: argv.includes('--all') })
  if (['archive', 'unarchive', 'delete', 'fork'].includes(command)) return runSessionCommand(command, argv.slice(1))
  if (command === 'resume') return runResume(argv.slice(1))
  if (CODEX_PASSTHROUGH.has(command)) return runCodexPassthrough(argv)
  return runPrompt(parseRunArgs(argv))
}

const code = await main()
if (code != null) process.exit(code)
