import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { keyToSequence } from "./keys.js";
import { exportRecording } from "./recording.js";
import { SessionManager } from "./session.js";
import { startWebUI, type WebUI } from "./web.js";

const DEFAULT_IDLE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function createServer(manager: SessionManager, opts: { port?: number; noWeb?: boolean } = {}) {
  const server = new McpServer(
    { name: "termmirror", version: "0.1.0" },
    {
      instructions:
        "Real interactive terminal sessions. The loop is always: send_input (or send_keys) -> " +
        "wait -> read_screen. read_screen returns a screenshot of the visible screen, not a log, " +
        "so read it after every wait. Use this for anything that blocks or prompts: another agent " +
        "CLI (claude, codex), REPLs, debuggers, ssh, installers, vim. A human can watch any session " +
        "live in the browser at the URL create_session returns, and type into it alongside you. " +
        "start_recording captures everything a session prints from then on, in the background, and " +
        "stop_recording writes it out as a GIF, mp4 or asciicast — use it to demo a workflow.",
    },
  );

  // The viewer only exists once there is something to view.
  let web: WebUI | null = null;
  let webError: string | null = null;
  async function ensureWeb() {
    if (web || opts.noWeb) return web;
    try {
      web = await startWebUI(manager, opts.port);
    } catch (err) {
      webError = `web UI unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    return web;
  }

  server.registerTool(
    "create_session",
    {
      title: "Create terminal session",
      description:
        "Start a long-lived interactive terminal session and return its id. Defaults to your login " +
        "shell; pass `command` to launch a program directly (e.g. \"claude\", \"python3\", \"ssh host\"). " +
        "The session outlives the call — nothing blocks. Returns a URL where a human can watch it live.",
      inputSchema: {
        command: z.string().optional().describe("Program to run. Defaults to $SHELL."),
        args: z.array(z.string()).optional().describe("Arguments for `command`."),
        cwd: z.string().optional().describe("Working directory. Defaults to the server's cwd."),
        cols: z.number().int().min(20).max(500).optional().describe("Terminal width (default 120)."),
        rows: z.number().int().min(5).max(200).optional().describe("Terminal height (default 40)."),
      },
    },
    async ({ command, args, cwd, cols, rows }) => {
      const session = manager.create({ command, args, cwd, cols, rows });
      await ensureWeb();
      return text({
        ...session.info(),
        watchUrl: web ? web.sessionUrl(session.id) : webError,
        next: "Call wait, then read_screen to see the initial screen.",
      });
    },
  );

  server.registerTool(
    "send_input",
    {
      title: "Type into a session",
      description:
        "Type text into the session, as a person would. Set `enter` to submit it. " +
        "Follow with wait, then read_screen — the input alone tells you nothing about what happened.",
      inputSchema: {
        session: z.string().describe("Session id from create_session."),
        text: z.string().describe("Literal text to type."),
        enter: z.boolean().optional().describe("Press Enter after the text (default false)."),
      },
    },
    async ({ session, text: input, enter }) => {
      const s = manager.get(session);
      s.write(enter ? `${input}\r` : input);
      return text({ ok: true, sent: input, enter: !!enter });
    },
  );

  server.registerTool(
    "send_keys",
    {
      title: "Send special keys",
      description:
        "Send control and navigation keys: ctrl+c, ctrl+d, escape, tab, enter, up, down, left, right, " +
        "home, end, pageup, pagedown, backspace, delete, f1-f12, alt+X. Keys are sent in order. " +
        "Use this to drive menus and TUIs; use send_input for ordinary text.",
      inputSchema: {
        session: z.string().describe("Session id."),
        keys: z.array(z.string()).min(1).describe('Key names, e.g. ["escape", "down", "enter"].'),
      },
    },
    async ({ session, keys }) => {
      const s = manager.get(session);
      for (const k of keys) s.write(keyToSequence(k));
      return text({ ok: true, keys });
    },
  );

  server.registerTool(
    "read_screen",
    {
      title: "Read the screen",
      description:
        "Return what is on the session's screen right now, as plain text. This is a screenshot: it " +
        "shows the current screen, so output that scrolled away is gone — pass `scrollback` to reach " +
        "back into history instead.",
      inputSchema: {
        session: z.string().describe("Session id."),
        tail: z.number().int().min(1).optional().describe("Only the last N rows of the visible screen."),
        scrollback: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Last N lines of history including what scrolled off. Ignores `tail`."),
      },
    },
    async ({ session, tail, scrollback }) => {
      const s = manager.get(session);
      const body = scrollback ? await s.scrollback(scrollback) : await s.screen(tail);
      const header = s.alive
        ? s.alternateScreen
          ? `[${s.id}: full-screen app active]`
          : `[${s.id}]`
        : `[${s.id}: exited with code ${s.exitCode}]`;
      return text(`${header}\n${body}`);
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for the session",
      description:
        "Block until the session is ready for you again — always call this between sending input and " +
        "reading the screen, or you will read the screen as it was before your input landed. Default " +
        "mode `idle` returns once the program has responded and then gone quiet for `idle_ms`; that is " +
        "the completion signal for agent CLIs, TUIs and spinners, which redraw while working and fall " +
        "silent when it is your turn. A `no_output` result means nothing happened at all: the program " +
        "is silently busy, or your input did not register. Use mode `pattern` when you know the exact " +
        "text to expect; it matches the whole screen, including your own echoed input, so never wait " +
        "for a marker you just typed. Raise `timeout` for slow work.",
      inputSchema: {
        session: z.string().describe("Session id."),
        mode: z.enum(["idle", "pattern"]).optional().describe("Default 'idle'."),
        pattern: z.string().optional().describe("Regex to match, required for mode 'pattern'."),
        ignore_case: z.boolean().optional().describe("Case-insensitive pattern match."),
        idle_ms: z.number().int().min(100).optional().describe(`Quiet period for idle mode (default ${DEFAULT_IDLE_MS}).`),
        timeout: z.number().int().min(100).optional().describe(`Give up after this many ms (default ${DEFAULT_TIMEOUT_MS}).`),
      },
    },
    async ({ session, mode, pattern, ignore_case, idle_ms, timeout }) => {
      const s = manager.get(session);
      const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
      if ((mode ?? "idle") === "pattern") {
        if (!pattern) throw new Error("mode 'pattern' requires `pattern`.");
        return text(await s.waitPattern(pattern, timeoutMs, ignore_case));
      }
      return text(await s.waitIdle(idle_ms ?? DEFAULT_IDLE_MS, timeoutMs));
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description: "Every session this server owns, alive or exited, with the URL to watch each one.",
      inputSchema: {},
    },
    async () => {
      await ensureWeb();
      return text({
        webUrl: web ? web.url : webError,
        sessions: manager.list().map((s) => ({ ...s.info(), watchUrl: web ? web.sessionUrl(s.id) : null })),
      });
    },
  );

  server.registerTool(
    "resize",
    {
      title: "Resize a session",
      description: "Change the terminal dimensions. TUIs redraw to fit; widen it when output wraps badly.",
      inputSchema: {
        session: z.string().describe("Session id."),
        cols: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(200),
      },
    },
    async ({ session, cols, rows }) => {
      const s = manager.get(session);
      s.resize(cols, rows);
      return text({ ok: true, cols, rows });
    },
  );

  server.registerTool(
    "start_recording",
    {
      title: "Start recording a session",
      description:
        "Begin capturing everything the session prints. Recording runs in the background — keep " +
        "driving the session normally — until stop_recording writes it out as a GIF, mp4 or " +
        "asciicast. Start it before the part you want to show.",
      inputSchema: {
        session: z.string().describe("Session id."),
        path: z
          .string()
          .optional()
          .describe("Where to write the .cast file. Defaults to ~/.termmirror/recordings/."),
      },
    },
    async ({ session, path: castPath }) => {
      const s = manager.get(session);
      return text({ recording: true, castPath: s.startRecording(castPath) });
    },
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop recording and export",
      description:
        "Finish the recording and render it. Default format `gif` is the one to share; `mp4` is " +
        "smaller for long sessions; `cast` skips rendering and leaves the asciicast, which replays " +
        "with `asciinema play`. gif and mp4 need the `agg` binary (`brew install agg`), mp4 also " +
        "needs ffmpeg — without them you still get the .cast back, plus how to install them.",
      inputSchema: {
        session: z.string().describe("Session id."),
        format: z.enum(["gif", "mp4", "cast"]).optional().describe("Default 'gif'."),
        output: z.string().optional().describe("Path for the rendered file. Defaults alongside the .cast."),
      },
    },
    async ({ session, format, output }) => {
      const s = manager.get(session);
      const result = await s.stopRecording();
      if (!result) throw new Error(`Session ${session} is not recording. Call start_recording first.`);

      const fmt = format ?? "gif";
      if (fmt === "cast") return text({ ...result, output: result.castPath });
      try {
        return text({ ...result, output: await exportRecording(result.castPath, fmt, output) });
      } catch (err) {
        // The cast is a complete recording on its own, so a missing renderer is a note, not a failure.
        return text({ ...result, note: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  server.registerTool(
    "kill_session",
    {
      title: "Kill a session",
      description: "Terminate the process and forget the session. Do this when you are done with it.",
      inputSchema: { session: z.string().describe("Session id.") },
    },
    async ({ session }) => {
      await manager.remove(session);
      return text({ ok: true, killed: session });
    },
  );

  return {
    server,
    async close() {
      await manager.killAll();
      await web?.close();
    },
  };
}
