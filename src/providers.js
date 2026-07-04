// Provider registry. Akorith drives locally installed agent CLIs — it never
// proxies traffic or stores credentials. Terminal names match the desktop app:
// Atlantis = Claude, Olympus = Codex, Gaia = OpenCode.

import { spawn, spawnSync } from 'node:child_process'
import { startSpinner, stripAnsi, text as bright, dim, faint, green, red, italic } from './ui.js'

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
  return `${p.codename.toLowerCase()} · ${p.id}/${model}`
}

// Per-provider output renderers: turn the raw CLI streams into a quiet,
// readable feed. Every rendered line goes through print() (the spinner's log),
// so the animated status line stays pinned at the bottom for the whole turn.
function createRenderer(providerId, print) {
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
    const finalAnswer = []
    const isDiffLine = (plain) =>
      /^(diff --git |index [0-9a-f]|new file mode |deleted file mode |--- |\+\+\+ |@@ )/.test(plain) ||
      (inDiff && /^[+\- ]/.test(plain))
    const say = (line) => {
      const plain = stripAnsi(line).trimEnd()
      if (!plain) {
        inDiff = false
        if (!lastBlank) print('')
        lastBlank = true
        return
      }
      // codex re-prints the cumulative diff after events — never show raw diffs
      if (isDiffLine(plain)) {
        inDiff = true
        return
      }
      lastBlank = false
      print(bright(plain))
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
        if (plain === 'user') return void (block = 'suppress')
        if (plain === 'codex') return void ((block = 'say'), (inDiff = false))
        if (plain === 'thinking') return void (block = 'think')
        if (plain === 'exec') return void ((block = 'exec'), (execHeader = true))
        if (plain === 'apply patch') return void ((block = 'patch'), (patchOk = null))
        if (plain === 'tokens used') return void (block = 'tokens')
        if (block === 'say') say(line)
        else if (block === 'think' && plain) print(faint(italic(plain)))
        else if (block === 'exec') {
          if (execHeader) {
            execHeader = false
            const m = plain.match(/-l?c '([\s\S]+)' in /)
            const cmd = m ? m[1] : plain.replace(/ in \/.*$/, '')
            print(faint('● ') + dim(cmd))
            lastBlank = false
          } else if (/succeeded in \S+:?\s*$/.test(plain)) {
            print(green('  ✓ ') + faint(plain.trim().replace(/:$/, '')))
          } else if (/(failed|exited \d+) in \S+:?\s*$/.test(plain)) {
            print(red('  ✗ ') + faint(plain.trim().replace(/:$/, '')))
          }
          // command output itself stays quiet — codex narrates what matters
        } else if (block === 'patch') {
          if (/^patch: /.test(plain)) {
            patchOk = /^patch: (completed|applied|success)/.test(plain)
          } else if (patchOk !== null && plain && !isDiffLine(plain)) {
            const file = plain.split('/').pop()
            const mark = patchOk ? green(' ✓') : red(' ✗')
            print(faint('● ') + dim('apply patch ' + file) + mark)
            lastBlank = false
            patchOk = null
          }
          // diff bodies stay quiet
        } else if (block === 'tokens' && plain) {
          print(faint('tokens ' + plain.trim()))
          block = 'suppress'
        }
      },
      flush() {
        // stderr log went missing (future codex versions?) — fall back to stdout
        if (!spokeFromLog && finalAnswer.some((l) => stripAnsi(l).trim())) {
          for (const line of finalAnswer) print(line)
        }
      },
    }
  }

  if (providerId === 'opencode') {
    // drop the leading blanks and the "> build · model" banner, keep the rest
    let started = false
    return {
      stdoutLine(line) {
        const plain = stripAnsi(line).trim()
        if (!started) {
          if (!plain || plain.startsWith('>')) return
          started = true
        }
        print(line)
      },
      stderrLine(line) {
        const plain = stripAnsi(line).trim()
        if (plain) print(dim(plain))
      },
      flush() {},
    }
  }

  // claude / ollama: answer arrives on stdout as-is
  return {
    stdoutLine(line) {
      print(line)
    },
    stderrLine(line) {
      const plain = stripAnsi(line).trim()
      if (plain) print(dim(plain))
    },
    flush() {},
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
    const renderer = createRenderer(provider.id, (line) => spinner.log(line))
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
