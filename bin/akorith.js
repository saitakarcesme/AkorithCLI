#!/usr/bin/env node
import { createRequire } from 'node:module'
import { startRepl } from '../src/repl.js'
import { detectProviders, parseModelSpec, runTurn } from '../src/providers.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const argv = process.argv.slice(2)

function usage() {
  console.log(`akorith v${version} — the Agent OS for your terminal

Usage:
  akorith                     start the interactive workspace
  akorith -m <spec>           start with a model, e.g. -m claude/sonnet
  akorith -p "<prompt>"       one-shot: send a prompt, print the answer, exit
  akorith --version           print version

Model specs: <provider>[/<model>] with provider one of claude, codex, opencode, ollama.
Inside the workspace: /model to switch, /help for everything else.`)
}

let initialModel = null
let oneShot = null

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--version' || arg === '-v') {
    console.log(version)
    process.exit(0)
  } else if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else if (arg === '--model' || arg === '-m') {
    initialModel = argv[++i]
  } else if (arg === '--prompt' || arg === '-p') {
    oneShot = argv[++i]
  } else {
    console.error(`Unknown argument: ${arg}`)
    usage()
    process.exit(1)
  }
}

if (initialModel && !parseModelSpec(initialModel)) {
  console.error(`Invalid model spec: ${initialModel} (expected <provider>[/<model>])`)
  process.exit(1)
}

if (oneShot !== null) {
  if (!oneShot.trim()) {
    console.error('Empty prompt.')
    process.exit(1)
  }
  const available = detectProviders()
  let selection = initialModel ? parseModelSpec(initialModel) : null
  if (!selection) {
    const fallback = ['claude', 'codex', 'opencode'].find((id) => available[id])
    selection = fallback ? { provider: fallback, model: null } : null
  }
  if (!selection || !available[selection.provider]) {
    console.error('No usable agent CLI found for this prompt.')
    process.exit(1)
  }
  const code = await runTurn({ selection, prompt: oneShot, resume: false, cwd: process.cwd() })
  process.exit(code)
}

startRepl({ version, initialModel })
