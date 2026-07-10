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

Akorith's interactive workspace opens with a Grok Build-style start screen:
a bordered launch card, the colorful pixel Akorith wordmark, a bottom input box,
model/context/token status in the input footer, and panel-based pickers for
models, sessions, commands, and reviews.

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
❯ /options                                      # inspect run flags (images, json, search, sandbox)
❯ /option image ./screenshot.png                # attach an image to future supported turns
❯ /option search on                             # enable Codex web search for future Codex turns
❯ /sessions                                     # list saved sessions for this folder
❯ /resume --last                                # resume the most recent Akorith session
❯ /fork <session-id>                            # fork a saved session into a fresh branch of work
❯ /review                                       # browse the diff file-by-file (/, n/p, r)
❯ /review --uncommitted                         # review staged, unstaged, and untracked changes
❯ /timeline                                     # browse transcript rows
❯ /timeline search authentication               # jump to the latest matching row
❯ /doctor                                       # diagnose local provider CLIs + global install
❯ /model                                        # open the model picker (↑/↓, Enter)
❯ /model codex                                  # switch to Codex (Olympus)
❯ /model gpt 5.5 high                           # switch via a friendly preset alias
❯ /model claude/sonnet                          # Claude with a specific model
❯ /model opencode-go/glm-5.2                    # Gaia/OpenCode with its exact model id
❯ /models                                       # list providers + status
❯ /new                                          # fresh conversations
❯ !git status                                   # run any shell command in place
❯ /exit
```

One-shot mode (scriptable):

```bash
akorith -p "summarize the diff" -m claude/haiku
akorith exec "fix the failing tests" -m codex/gpt-5-codex -C ~/code/app --search
akorith review --uncommitted -m codex/gpt-5-codex
akorith resume --last "continue from where we left off"
```

When stdin is piped, Akorith treats it as a one-shot prompt or appends it to
the prompt in a `<stdin>` block, matching the scriptable Codex-style flow.

## Codex-style command surface

Akorith now has native equivalents for the day-to-day Codex CLI surfaces that
matter when you want to live in one terminal:

| Codex surface | Akorith surface |
|---|---|
| `codex <prompt>` / `codex exec` | `akorith <prompt>` / `akorith exec` |
| `-C, --cd` | `akorith -C <dir>` and `/cd <dir>` |
| `-i, --image` | `akorith -i <file>` and `/option image <file>` |
| `--add-dir` | `akorith --add-dir <dir>` and `/option add-dir <dir>` |
| `--search` | `akorith --search` and `/option search on` |
| `--json`, `--output-schema`, `-o` | same CLI flags and `/option json/schema/output` |
| `-s, --sandbox` | same CLI flag and `/option sandbox <mode>` |
| `-a, --ask-for-approval` | accepted for compatibility; forwarded only where the provider supports it |
| `codex review` | `akorith review` with `--uncommitted`, `--base`, `--commit`, `--title` |
| `resume/archive/delete/fork` | native Akorith session commands and slash commands |
| `doctor/update` | `akorith doctor` and `akorith update` |

Codex-only administrative tools are still reachable without leaving Akorith:

```bash
akorith codex mcp list
akorith codex plugin list
akorith codex completion zsh
akorith codex cloud
akorith codex apply
```

Those commands deliberately pass through to the installed Codex CLI because
they manage Codex-specific config, auth, plugins, MCP servers, cloud tasks, and
shell completion formats.

## How it works

| Akorith name | Provider | Driven via |
|---|---|---|
| Atlantis | Claude | `claude -p` (continues with `-c`) |
| Olympus | Codex | `codex exec` (continues with `resume --last`) |
| Gaia | OpenCode | `opencode run` (continues with `-c`) |
| Local | Ollama | `ollama run` |

Each provider keeps its own conversation thread for the live session; `/new` resets all of
them. Akorith also keeps a lightweight session index in `~/.akorith/sessions.json`
so you can resume, fork, archive, and delete work from the terminal. Your last
model, mode, and run-option choices are remembered in `~/.akorith/cli.json`.
Press `⌘M`/`Alt+M` to open the model picker when your terminal passes that key
through; `/model` opens the same picker everywhere. Use ↑/↓ and Enter to pick,
or type a number/alias/model spec directly.
Olympus entries are Codex/GPT models, Atlantis entries are Claude models, and
Gaia entries are loaded from `opencode models` so they appear as exact OpenCode
model IDs such as `opencode-go/glm-5.2` rather than a vague default.
Long submitted prompts are re-rendered with word wrapping, and the start screen
reflows with the terminal width without splitting words in the middle.
The live `akoriting` line shows the current high-level phase while a model is working.
Akorith shows provider-supplied output and high-level phases; it does not expose
hidden private chain-of-thought from models.

### Responsive terminal workspace

Interactive TTY sessions use one atomic full-screen frame: a persistent Akorith
header, a scrollable transcript/overlay area, and a closed composer anchored to
the bottom edge. The layout switches between compact, regular, and wide modes,
keeps the cursor stable during resize, and measures emoji/CJK text by terminal
cell width. Non-TTY and `TERM=dumb` output keeps the plain script-friendly flow.

- `Enter` sends; `Shift+Enter` or `Ctrl+J` inserts a newline.
- `↑`/`↓` recall prompt history and restore the unfinished draft.
- `Ctrl+P` opens the filterable command palette; `Alt+M` opens models where supported.
- `PageUp`/`PageDown` scroll the transcript; `Ctrl+X`, then `G`, opens `/timeline`.
- `Ctrl+T` cycles reasoning visibility; `Ctrl+C` cancels a turn or activates the exit guard.
- `AKORITH_REDUCED_MOTION=1` disables animation, `AKORITH_MONO=1` disables brand color,
  and `AKORITH_NO_FULLSCREEN=1` selects the classic streaming fallback.

The footer reports model, permission mode, provider context, cumulative tokens,
queue depth, and context pressure when the provider has a known context limit.
The header retains session/turn identity, working directory, git branch/dirty
state, provider availability, and working/ready status after every turn.

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
