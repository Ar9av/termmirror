import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { keyToSequence } from "./keys.js";
import { concatVideos, exportRecording, exportVideo } from "./recording.js";
import type { Session, SessionManager } from "./session.js";
import type { BrowserSession } from "./browser.js";
import { startWebUI, type WebUI } from "./web.js";

const DEFAULT_IDLE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30_000;

// Read rather than duplicated, so the version a client sees cannot drift from the package.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function createServer(manager: SessionManager, opts: { port?: number; noWeb?: boolean } = {}) {
  const server = new McpServer(
    { name: "termmirror", version },
    {
      instructions:
        "Real interactive terminal sessions. The loop is always: send_input (or send_keys) -> " +
        "wait -> read_screen. read_screen returns a screenshot of the visible screen, not a log, " +
        "so read it after every wait. Use this for anything that blocks or prompts: another agent " +
        "CLI (claude, codex), REPLs, debuggers, ssh, installers, vim. A human can watch any session " +
        "live in the browser at the URL create_session returns, and type into it alongside you. " +
        "start_recording captures everything a session prints from then on, in the background, and " +
        "stop_recording writes it out as a GIF, mp4 or asciicast — use it to demo a workflow. " +
        "A web browser is the same kind of session under the browser_* tools: browser_open -> " +
        "browser_act (which returns the new page) -> browser_wait when something is still loading. " +
        "Click and type by the [ref=eN] in the page snapshot, never by guessing coordinates. Browser " +
        "sessions watch, take over and record exactly like terminals do.",
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
        "Type text into the session, as a person would. It waits for the screen to stop redrawing " +
        "before typing, because keys that land mid-redraw are silently lost. Set `enter` to submit. " +
        "Follow with wait, then read_screen — the input alone tells you nothing about what happened.",
      inputSchema: {
        session: z.string().describe("Session id from create_session."),
        text: z.string().describe("Literal text to type."),
        enter: z.boolean().optional().describe("Press Enter after the text (default false)."),
      },
    },
    async ({ session, text: input, enter }) => {
      const s = manager.get(session);
      await s.type(input, !!enter);
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
      // A frozen screen otherwise reads as a real one: everything still says alive, and
      // the agent keeps acting on a snapshot that stopped updating. Say it out loud.
      const stale = s.staleReason ? `\n[${s.id}: STALE — ${s.staleReason}]` : "";
      return text(`${header}${stale}\n${body}`);
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
        "Begin capturing the session. Recording runs in the background — keep driving the session " +
        "normally — until stop_recording writes it out as a GIF, mp4 or asciicast. Works on a " +
        "browser session too, where it captures the page as video and draws the cursor and a " +
        "highlight on everything you click. Start it before the part you want to show.",
      inputSchema: {
        session: z.string().describe("Session id, terminal or browser."),
        path: z
          .string()
          .optional()
          .describe("Where to write the raw recording: .cast for a terminal, .webm for a browser. Defaults to ~/.termmirror/recordings/."),
      },
    },
    async ({ session, path: castPath }) => {
      const s = manager.any(session);
      // A browser's start is async and throws if the screencast could not open.
      const file = await s.startRecording(castPath);
      return text({ recording: true, [s.info().kind === "browser" ? "videoPath" : "castPath"]: file });
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
        "needs ffmpeg — without them you still get the .cast back, plus how to install them. " +
        "Pauses longer than `idle_time_limit` seconds are shortened in the render, so a long agent " +
        "turn does not become a minute of a still frame. A browser session records to .webm and " +
        "renders with ffmpeg alone; `idle_time_limit` and `select` do not apply to it, because a " +
        "video has no event stream to re-time.",
      inputSchema: {
        session: z.string().describe("Session id, terminal or browser."),
        format: z.enum(["gif", "mp4", "cast"]).optional().describe("Default 'gif'. 'cast' is terminal-only."),
        output: z.string().optional().describe("Path for the rendered file. Defaults alongside the .cast."),
        idle_time_limit: z
          .number()
          .positive()
          .nullable()
          .optional()
          .describe("Cap pauses at this many seconds (default 2). Pass null to keep real timing."),
        speed: z.number().positive().optional().describe("Playback speed multiplier, e.g. 1.5."),
        select: z
          .string()
          .optional()
          .describe(
            'Render only part of the recording, in seconds: "40:" from 40s on, ":90" up to 90s, ' +
              '"40:90" between. Use this to cut a stretch that is busy but not worth watching — a ' +
              "spinner redrawing for a minute is never idle, so idle_time_limit will not touch it.",
          ),
      },
    },
    async ({ session, format, output, idle_time_limit, speed, select }) => {
      const s = manager.any(session);
      if (s.info().kind === "browser") {
        const done = await (s as BrowserSession).stopRecording();
        if (!done) throw new Error(`Session ${session} is not recording. Call start_recording first.`);
        const fmt = format ?? "gif";
        const skipped = [idle_time_limit !== undefined && "idle_time_limit", select && "select"].filter(Boolean);
        const note = skipped.length ? { note: `${skipped.join(" and ")} only applies to terminal recordings — ignored.` } : {};
        if (fmt === "cast") {
          return text({
            ...done,
            output: done.videoPath,
            note: "a browser records to video, not an asciicast — this is the raw .webm.",
          });
        }
        try {
          // Following the page across tabs splits the recording into one file per tab; they
          // have to be one video again before anything is rendered from them.
          const source = await concatVideos(done.segments);
          return text({ ...done, ...note, output: await exportVideo(source, fmt, output, { speed }) });
        } catch (err) {
          // The .webm plays on its own, so a missing ffmpeg is a note rather than a failure.
          return text({ ...done, output: done.videoPath, note: err instanceof Error ? err.message : String(err) });
        }
      }

      const result = await (s as Session).stopRecording();
      if (!result) throw new Error(`Session ${session} is not recording. Call start_recording first.`);

      const fmt = format ?? "gif";
      if (fmt === "cast") return text({ ...result, output: result.castPath });
      try {
        const rendered = await exportRecording(result.castPath, fmt, output, {
          idleTimeLimit: idle_time_limit,
          speed,
          select,
        });
        return text({ ...result, output: rendered });
      } catch (err) {
        // The cast is a complete recording on its own, so a missing renderer is a note, not a failure.
        return text({ ...result, note: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  server.registerTool(
    "browser_open",
    {
      title: "Open a browser session",
      description:
        "Launch a real Chrome window the agent drives and a human can watch — the browser " +
        "equivalent of create_session. Returns the session id, a URL where a human can watch and " +
        "click alongside you, and the page snapshot if you passed a url. Headed by default, so " +
        "the window is visible on the machine; pass headless for a server. Pass `profile` to reuse " +
        "a named on-disk Chrome profile, which keeps logins between sessions.",
      inputSchema: {
        url: z.string().optional().describe("Page to open first. Bare hosts get https://."),
        headless: z.boolean().optional().describe("Run with no visible window (default false)."),
        width: z.number().int().min(320).max(3840).optional().describe("Viewport width (default 1280)."),
        height: z.number().int().min(240).max(2160).optional().describe("Viewport height (default 800)."),
        profile: z
          .string()
          .optional()
          .describe("Named persistent profile, kept under ~/.termmirror/profiles. Only one session per profile at a time."),
      },
    },
    async ({ url, headless, width, height, profile }) => {
      const session = await manager.createBrowser({ url, headless, width, height, profile });
      await ensureWeb();
      return text({
        ...session.info(),
        watchUrl: web ? web.sessionUrl(session.id) : webError,
        ...(url ? { snapshot: await session.snapshot() } : { next: "Call browser_navigate to load a page." }),
      });
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Go to a URL",
      description: "Load a page in a browser session and return its snapshot once the DOM is ready.",
      inputSchema: {
        session: z.string().describe("Browser session id from browser_open."),
        url: z.string().describe("Where to go. Bare hosts get https://."),
      },
    },
    async ({ session, url }) => {
      const b = manager.getBrowser(session);
      await b.navigate(url);
      return text(await b.snapshot());
    },
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Read the page",
      description:
        "Return the page as an accessibility tree: every element with its role, its text, and a " +
        "`[ref=eN]` handle. Those refs are what browser_act targets — they are stable and exact, " +
        "where guessed coordinates are not. Set `screenshot` when the layout itself is the question; " +
        "the tree alone answers what is on the page and what can be clicked. Big pages are cut at " +
        "about 4k tokens with a note saying so — pass `depth` to see the whole page in less detail, " +
        "or `full` to get all of it.",
      inputSchema: {
        session: z.string().describe("Browser session id."),
        depth: z.number().int().min(1).optional().describe("Limit how deep the tree goes, for a large page."),
        full: z.boolean().optional().describe("Return the whole tree however large (default: cut at ~4k tokens)."),
        screenshot: z.boolean().optional().describe("Also return a JPEG of the viewport (default false)."),
      },
    },
    async ({ session, depth, full, screenshot }) => {
      const b = manager.getBrowser(session);
      const tree = await b.snapshot(depth, full);
      if (!screenshot) return text(tree);
      return {
        content: [
          { type: "text" as const, text: tree },
          { type: "image" as const, data: await b.screenshot(), mimeType: "image/jpeg" },
        ],
      };
    },
  );

  server.registerTool(
    "browser_act",
    {
      title: "Act on the page",
      description:
        "Do one thing to the page and get the resulting snapshot back, so this is usually the only " +
        "call you need per step. `target` is a `[ref=eN]` from the last snapshot, or a CSS selector. " +
        "Kinds: click; type (fills a field, set `enter` to submit); press (a key, with no target it " +
        "goes to the page); hover; select (choose `text` in a dropdown); scroll (a target scrolls it " +
        "into view, no target scrolls the page by `amount` pixels); upload (attach `files` to a file " +
        "input). Refs go stale when the page changes — always act on the refs from the snapshot " +
        "you just read. If this action pops up an alert, confirm or prompt, set `dialog` to say how " +
        "to answer it: a dialog freezes the page until it is answered, so the decision cannot wait " +
        "until afterwards, and an unanswered one is dismissed. A click that opens a new tab switches " +
        "to that tab, and the snapshot you get back is the new one.",
      inputSchema: {
        session: z.string().describe("Browser session id."),
        kind: z.enum(["click", "type", "press", "hover", "select", "scroll", "upload"]).describe("What to do."),
        target: z.string().optional().describe('A ref like "e12", or a CSS selector.'),
        text: z.string().optional().describe("Text to type, or the option to select."),
        key: z.string().optional().describe('Key for `press`, e.g. "Enter", "Escape", "ArrowDown", "Control+a".'),
        amount: z.number().optional().describe("Pixels to scroll. Negative scrolls up."),
        enter: z.boolean().optional().describe("Press Enter after typing (default false)."),
        files: z.array(z.string()).min(1).optional().describe("Local file paths for `upload`."),
        dialog: z
          .enum(["accept", "dismiss"])
          .optional()
          .describe("How to answer an alert, confirm or prompt this action raises (default dismiss)."),
        dialog_text: z.string().optional().describe("Answer to type into a prompt() that is being accepted."),
        settle_ms: z.number().int().min(0).optional().describe("Pause before snapshotting, for animations (default 250)."),
      },
    },
    async ({ session, kind, target, text: value, key, amount, enter, files, dialog, dialog_text, settle_ms }) => {
      const b = manager.getBrowser(session);
      await b.act({ kind, target, text: value, key, amount, enter, files, dialog, dialogText: dialog_text });
      // A click that starts a navigation or a transition leaves the tree mid-change; a short
      // pause makes the snapshot describe the page the action produced.
      await new Promise((r) => setTimeout(r, settle_ms ?? 250));
      return text(await b.snapshot());
    },
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "List or switch tabs",
      description:
        "Work with the session's tabs. A click that opens a new tab already switches to it, so " +
        "reach for this when you need to go back to the one you came from, open a second tab " +
        "yourself, or close one you are done with. `list` is also how you find out what a popup " +
        "was. `select` and `new` return the snapshot of the tab you land on.",
      inputSchema: {
        session: z.string().describe("Browser session id."),
        action: z.enum(["list", "select", "new", "close"]).optional().describe("Default 'list'."),
        index: z.number().int().min(0).optional().describe("Which tab, for select and close. From `list`."),
        url: z.string().optional().describe("Page to open in the new tab, for `new`."),
      },
    },
    async ({ session, action, index, url }) => {
      const b = manager.getBrowser(session);
      const which = action ?? "list";
      if (which === "list") return text({ tabs: await b.tabList() });

      if (which === "new") {
        await b.newTab(url);
        return text(await b.snapshot());
      }
      if (index === undefined) throw new Error(`action '${which}' requires \`index\` — call action 'list' to see them.`);
      if (which === "close") {
        await b.closeTab(index);
        return text({ ok: true, closed: index, tabs: await b.tabList() });
      }
      await b.selectTab(index);
      return text(await b.snapshot());
    },
  );

  server.registerTool(
    "browser_wait",
    {
      title: "Wait for the page",
      description:
        "Block until the page is ready. Mode `idle` (the default) waits for network activity to " +
        "stop — right after a navigation or a form submit. Mode `pattern` waits for text to appear " +
        "anywhere in the page's visible text, which is the one to use when you know what should " +
        "show up. browser_act already pauses briefly, so reach for this only when something is " +
        "genuinely slow.",
      inputSchema: {
        session: z.string().describe("Browser session id."),
        mode: z.enum(["idle", "pattern"]).optional().describe("Default 'idle'."),
        pattern: z.string().optional().describe("Regex to find in the page text, required for mode 'pattern'."),
        ignore_case: z.boolean().optional().describe("Case-insensitive pattern match."),
        timeout: z.number().int().min(100).optional().describe(`Give up after this many ms (default ${DEFAULT_TIMEOUT_MS}).`),
      },
    },
    async ({ session, mode, pattern, ignore_case, timeout }) => {
      const b = manager.getBrowser(session);
      const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
      if ((mode ?? "idle") === "pattern") {
        if (!pattern) throw new Error("mode 'pattern' requires `pattern`.");
        return text(await b.waitPattern(pattern, timeoutMs, ignore_case));
      }
      return text(await b.waitIdle(timeoutMs));
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
