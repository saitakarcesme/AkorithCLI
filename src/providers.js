// Provider registry. Akorith drives locally installed agent CLIs — it never
// proxies traffic or stores credentials. Terminal names match the desktop app:
// Atlantis = Claude, Olympus = Codex, Gaia = OpenCode.

import { spawn, spawnSync } from 'node:child_process'
import { startSpinner } from './ui.js'

export const PROVIDERS = {
  claude: {
    id: 'claude',
    codename: 'Atlantis',
    bin: 'claude',
    hint: 'model aliases: opus, sonnet, haiku (e.g. /model claude/sonnet)',
    args({ prompt, model, resume }) {
      const args = ['-p', prompt]
      if (model) args.push('--model', model)
      if (resume) args.push('-c')
      return args
    },
  },
  codex: {
    id: 'codex',
    codename: 'Olympus',
    bin: 'codex',
    hint: 'pass any Codex model id (e.g. /model codex/gpt-5-codex)',
    args({ prompt, model, resume }) {
      const args = resume ? ['exec', 'resume', '--last', prompt] : ['exec', prompt]
      args.push('--skip-git-repo-check')
      if (model) args.push('-m', model)
      return args
    },
  },
  opencode: {
    id: 'opencode',
    codename: 'Gaia',
    bin: 'opencode',
    hint: 'model format provider/model (e.g. /model opencode/anthropic/claude-sonnet-4-5)',
    args({ prompt, model, resume }) {
      const args = ['run', prompt]
      if (model) args.push('-m', model)
      if (resume) args.push('-c')
      return args
    },
  },
  ollama: {
    id: 'ollama',
    codename: 'Local',
    bin: 'ollama',
    hint: 'requires a running Ollama install (e.g. /model ollama/qwen3)',
    args({ prompt, model }) {
      return ['run', model || 'llama3.2', prompt]
    },
  },
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

export function formatModel(selection) {
  const p = PROVIDERS[selection.provider]
  const model = selection.model || 'default'
  return `${p.codename.toLowerCase()} · ${p.id}/${model}`
}

// Runs one turn against the selected provider, streaming output straight to
// the terminal. A colored "thinking/working" spinner runs until the provider
// produces its first byte. Resolves with the exit code; Ctrl+C kills only the
// child. Output is piped (not inherited) so the spinner can hand off cleanly —
// FORCE_COLOR/CLICOLOR_FORCE keep the providers' own colors alive despite the
// non-TTY pipe.
export function runTurn({ selection, prompt, resume, cwd }, { onSpawn } = {}) {
  const provider = PROVIDERS[selection.provider]
  const args = provider.args({ prompt, model: selection.model, resume })
  return new Promise((resolve) => {
    const child = spawn(provider.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
    })
    onSpawn?.(child)

    let spinner = startSpinner(provider.codename.toLowerCase())
    const handoff = () => {
      if (spinner) {
        spinner.stop()
        spinner = null
      }
    }
    child.stdout.on('data', (chunk) => {
      handoff()
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      handoff()
      process.stderr.write(chunk)
    })

    child.on('error', (err) => {
      handoff()
      if (err.code === 'ENOENT') {
        console.error(`\n${provider.bin}: not installed — install it to use this provider.`)
      } else {
        console.error(`\n${provider.bin}: ${err.message}`)
      }
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      handoff()
      resolve(signal ? 130 : code ?? 0)
    })
  })
}
