# Akorith CLI

The Agent OS for your terminal. One prompt for **Claude**, **Codex**, and **OpenCode** —
switch models mid-session, keep separate conversation threads per provider, and stay
local-first: Akorith never proxies your traffic or stores credentials. It drives the
agent CLIs you already have installed and signed into.

## Install

```bash
curl -fsSL https://akorith.space/install | bash
```

or directly via npm:

```bash
npm install -g akorith
```

Then type `akorith` in any terminal.

### From this repo (development)

```bash
npm install -g .
```

## Use

```
❯ refactor the auth module and add tests        # goes to the active model
❯ /mode view                                    # read-only; /mode act to work (default)
❯ /model codex                                  # switch to Codex (Olympus)
❯ /model claude/sonnet                          # Claude with a specific model
❯ /model opencode/anthropic/claude-sonnet-4-5   # OpenCode with provider/model
❯ /models                                       # list providers + status
❯ /new                                          # fresh conversations
❯ !git status                                   # run any shell command in place
❯ /exit
```

One-shot mode (scriptable):

```bash
akorith -p "summarize the diff" -m claude/haiku
```

## How it works

| Akorith name | Provider | Driven via |
|---|---|---|
| Atlantis | Claude | `claude -p` (continues with `-c`) |
| Olympus | Codex | `codex exec` (continues with `resume --last`) |
| Gaia | OpenCode | `opencode run` (continues with `-c`) |
| Local | Ollama | `ollama run` |

Each provider keeps its own conversation thread for the session; `/new` resets all of
them. Your last model and mode choices are remembered in `~/.akorith/cli.json`.

### Permission modes

- **act** (default) — models can do real work: file edits are auto-approved and
  commands run sandboxed to the workspace (`claude --permission-mode acceptEdits`,
  `codex` with `sandbox_mode="workspace-write"`, `opencode --auto`).
- **view** — strictly read-only: `claude --permission-mode plan`, Codex's read-only
  sandbox, and OpenCode's plan agent. Models can look but never write or execute.

## Requirements

- Node.js 18+
- At least one of: [claude](https://claude.com/claude-code), [codex](https://openai.com/codex),
  [opencode](https://opencode.ai), [ollama](https://ollama.com)
