# termmirror

An MCP server that gives AI agents real interactive terminal sessions — and a live web view
where a human can watch those sessions and type into them.

Most agent tooling can only run commands that exit on their own. Anything that prompts,
redraws, or waits for a keystroke is out of reach: installers, `ssh` with a password
challenge, `pdb`, `vim`, a package manager's configuration screen — and another agent's CLI.
termmirror keeps real PTY sessions open so an agent can work them the way a person does, one
keystroke at a time, while a human can look over its shoulder and step in when needed.

![One agent driving another agent's CLI, watched live in the browser](docs/driving-claude-code.jpg)

*One agent driving a Claude Code session through termmirror — it accepted the trust prompt,
asked a question, and read the answer off the screen. The browser view is live, and typing in
it goes straight to the same terminal.*

![A vim session driven keystroke by keystroke](docs/driving-vim.jpg)

*A full-screen TUI under the same tools: the agent opened `vim`, moved to the end of the
file, entered insert mode, and typed a line.*

## Features

- **Real PTY sessions.** Backed by `node-pty` with a headless terminal emulator holding
  screen state. No `tmux` or other external dependency.
- **Built for TUIs.** Alternate-screen detection, key encoding for control and navigation
  keys, and scrollback that unwraps soft-wrapped lines.
- **Reliable waiting.** `wait` returns once a program has responded *and* settled, so the
  screen you read reflects your input rather than the state before it.
- **Live web view.** Any session can be watched in the browser as it runs. Typing in the
  page goes straight to the PTY, so a human can take over and hand back.
- **Agent-to-agent.** Designed so one agent can drive another agent's CLI through a
  multi-turn conversation.

## Requirements

- Node.js 20 or newer
- macOS or Linux

## Installation

```bash
git clone https://github.com/Ar9av/termmirror.git
cd termmirror
npm install && npm run build
```

Register the server with Claude Code:

```bash
claude mcp add termmirror -- node /absolute/path/to/termmirror/dist/src/index.js
```

Any MCP client works; the server speaks stdio.

## Usage

Three tools, used in this order:

```
send_input  →  wait  →  read_screen
```

`read_screen` returns the screen as it looks now — a screenshot, not a log of everything
printed. `wait` is what makes that screenshot worth reading: it blocks until the program has
responded and gone quiet, so you see the state *after* your keystroke.

### Tools

| Tool | Description |
| --- | --- |
| `create_session` | Starts a session (`$SHELL` by default, or any command) and returns its id plus a URL to watch it. |
| `send_input` | Types text into a session, optionally submitting it with Enter. |
| `send_keys` | Sends `ctrl+c`, `escape`, `tab`, arrow keys, `f1`–`f12`, `alt+X`, and similar. |
| `read_screen` | Returns the visible screen as plain text; `scrollback` reaches into history. |
| `wait` | Waits for the session to respond and settle (`idle`), or for text to appear (`pattern`). |
| `list_sessions` | Lists all sessions, alive or exited, with watch URLs. |
| `resize` | Changes the terminal dimensions. |
| `kill_session` | Terminates a session. |

### Waiting

`idle` is the default and the right choice in most cases. Interactive programs redraw
continuously while they work and fall silent when it is your turn, so silence is a reliable
completion signal — including for spinners and TUIs that expose no prompt to match against.
Increase `timeout` for slow operations.

A `no_output` result means nothing came back since your input: the program is either busy and
silent, or the input never registered.

Use `pattern` when the expected text is known. It matches against the whole screen, including
your own echoed input, so wait for something the *program* prints rather than a marker you
just typed.

## Watching a session

The first session starts a local web server on port 7878. Open the URL returned by
`create_session` to see the session live. Typing in the page writes directly to the PTY,
which lets a human enter a password or answer a prompt the agent should not handle, then hand
control back — no handoff protocol, just the same terminal from the other side.

| Variable | Effect |
| --- | --- |
| `TERMINAL_UI_PORT` | Port for the web view (default `7878`; `0` picks a free port). |
| `TERMINAL_NO_UI` | Set to `1` to disable the web view entirely. |

## Example

```bash
node examples/drive-claude.mjs "what is 2+2? reply with just the number"
```

One agent starts `claude`, accepts its trust prompt, asks a question, and reads the answer off
the screen — the same tools the MCP interface exposes, written out longhand.

## Development

```bash
npm run build    # compile TypeScript to dist/
npm test         # build, then run the test suite
```

The suite covers the wait semantics the rest of the server depends on, key encoding,
scrollback, the web view's live stream and take-over typing, and an end-to-end run over the
real MCP protocol.

## A note on the name

The package is `termmirror`, with two m's. `alias/termirror/` is a stub package that depends
on it so the one-`m` spelling resolves to the right place.

## License

MIT
