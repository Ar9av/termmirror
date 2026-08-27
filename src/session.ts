import headless from "@xterm/headless";
import pty from "node-pty";

// Both packages are CommonJS; interop gives us the namespace on the default export.
const { Terminal } = headless;
import os from "node:os";

export interface SessionOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface WaitResult {
  ok: boolean;
  reason: "idle" | "pattern" | "exited" | "timeout" | "no_output";
  match?: string;
  note?: string;
}

const REPLAY_LIMIT = 256 * 1024;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Session {
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly startedAt = new Date();

  private proc: pty.IPty;
  private term: InstanceType<typeof Terminal>;
  private listeners = new Set<(chunk: string) => void>();
  private replay: string[] = [];
  private replayBytes = 0;

  alive = true;
  exitCode: number | null = null;
  lastDataAt = Date.now();
  /** Bumped on every chunk from the process, so a waiter can tell new output from old. */
  outputCount = 0;
  /** Value of outputCount when input was last sent — the anchor for "has it responded yet?". */
  private outputsAtLastInput = 0;

  constructor(id: string, opts: SessionOptions) {
    this.id = id;
    // A bare shell is the default: the agent then drives it like a person would.
    this.command = opts.command ?? process.env.SHELL ?? "/bin/bash";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd ?? process.cwd();

    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.proc = pty.spawn(this.command, this.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color", ...opts.env } as Record<string, string>,
    });

    // A real terminal answers the queries programs send it (cursor position, device
    // attributes, keyboard protocol). Without this the emulator stays mute and TUIs
    // that query on startup swallow the first keystroke waiting for a reply.
    this.term.onData((reply) => {
      if (this.alive) this.proc.write(reply);
    });

    this.proc.onData((chunk) => {
      this.lastDataAt = Date.now();
      this.outputCount++;
      this.term.write(chunk);
      this.pushReplay(chunk);
      for (const l of this.listeners) l(chunk);
    });

    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this.lastDataAt = Date.now();
      for (const l of this.listeners) l(`\r\n[process exited with code ${exitCode}]\r\n`);
    });
  }

  private pushReplay(chunk: string) {
    this.replay.push(chunk);
    this.replayBytes += chunk.length;
    while (this.replayBytes > REPLAY_LIMIT && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift()!.length;
    }
  }

  get cols() {
    return this.term.cols;
  }

  get rows() {
    return this.term.rows;
  }

  get alternateScreen() {
    return this.term.buffer.active.type === "alternate";
  }

  write(data: string) {
    if (!this.alive) throw new Error(`Session ${this.id} has exited`);
    this.outputsAtLastInput = this.outputCount;
    this.proc.write(data);
  }

  resize(cols: number, rows: number) {
    if (this.alive) this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  onData(listener: (chunk: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Output history for a newly attached viewer. */
  replayBuffer() {
    return this.replay.join("");
  }

  /** Wait for the emulator to finish applying queued writes before reading the screen. */
  private flush() {
    return new Promise<void>((resolve) => this.term.write("", () => resolve()));
  }

  /** The visible screen as plain text, trailing blank lines trimmed. */
  async screen(tail?: number): Promise<string> {
    await this.flush();
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return (tail ? lines.slice(-tail) : lines).join("\n");
  }

  /** The last `count` logical lines of scrollback + screen, unwrapping soft-wrapped rows. */
  async scrollback(count: number): Promise<string> {
    await this.flush();
    const buf = this.term.buffer.active;
    const logical: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && logical.length) logical[logical.length - 1] += text;
      else logical.push(text);
    }
    while (logical.length && logical[logical.length - 1].trim() === "") logical.pop();
    return logical.slice(-count).join("\n");
  }

  /**
   * Resolve once the process has responded and then gone quiet for `idleMs`.
   *
   * "Responded" is measured from the last input rather than from this call, which
   * matters because the two arrive as separate tool calls: a quick program often
   * answers before the wait even starts. Anchoring on the call would then block
   * for the full timeout, and anchoring on nothing at all would return a screen
   * still showing the state from before the keystroke.
   */
  async waitIdle(idleMs: number, timeoutMs: number): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (!this.alive) return { ok: true, reason: "exited" };
      const responded = this.outputCount > this.outputsAtLastInput;
      if (responded && Date.now() - this.lastDataAt >= idleMs) return { ok: true, reason: "idle" };
      if (Date.now() >= deadline) {
        return responded
          ? { ok: false, reason: "timeout", note: "Still producing output — read the screen or wait again." }
          : {
              ok: false,
              reason: "no_output",
              note: "Nothing has come back since your last input. Either the program is busy and silent, or the input did not register.",
            };
      }
      await sleep(50);
    }
  }

  /** Resolve once `pattern` matches the visible screen. */
  async waitPattern(pattern: string, timeoutMs: number, ignoreCase = false): Promise<WaitResult> {
    const re = new RegExp(pattern, ignoreCase ? "i" : undefined);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const m = re.exec(await this.screen());
      if (m) return { ok: true, reason: "pattern", match: m[0] };
      if (!this.alive) return { ok: false, reason: "exited" };
      if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
      await sleep(100);
    }
  }

  async kill() {
    if (!this.alive) return;
    this.proc.kill();
    for (let i = 0; i < 20 && this.alive; i++) await sleep(100);
    if (this.alive) this.proc.kill("SIGKILL");
  }

  info() {
    return {
      id: this.id,
      command: [this.command, ...this.args].join(" "),
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      screen: this.alternateScreen ? "alternate" : "normal",
      startedAt: this.startedAt.toISOString(),
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private counter = 0;

  create(opts: SessionOptions = {}): Session {
    const id = `term-${++this.counter}`;
    const session = new Session(id, opts);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) {
      const known = [...this.sessions.keys()].join(", ") || "none";
      throw new Error(`No session "${id}". Existing sessions: ${known}`);
    }
    return s;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  async remove(id: string) {
    const s = this.get(id);
    await s.kill();
    this.sessions.delete(id);
  }

  async killAll() {
    await Promise.all(this.list().map((s) => s.kill()));
    this.sessions.clear();
  }
}

export const hostname = os.hostname();
