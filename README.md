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
❯ push this commit to origin                    # models drive git/gh directly
❯ /connect                                      # see & toggle GitHub, git, npm
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

### Connections

In act mode, Akorith lets models drive the external tools you're already signed into,
so requests like *"push this commit"* or *"open a PR"* run end to end without a human
approving each step. Type `/connect` to see and toggle them:

- **Git** — commit, branch, push, pull in the current repo
- **GitHub** — PRs, issues, releases, repo create/clone (via `gh`, uses your login)
- **npm** — install, run scripts, publish

Under the hood this pre-approves `Bash(git:*)`, `Bash(gh:*)`, `Bash(npm:*)` for Claude
and opens Codex's workspace sandbox to the network (it's blocked by default, which is
why plain act mode couldn't push). Connections are on by default when detected and
remembered in `~/.akorith/connections.json`; `/connect github off` disables one.

## Requirements

- Node.js 18+
- At least one of: [claude](https://claude.com/claude-code), [codex](https://openai.com/codex),
  [opencode](https://opencode.ai), [ollama](https://ollama.com)
