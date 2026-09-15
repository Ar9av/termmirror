import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

export type Format = "cast" | "gif" | "mp4";

export interface ExportOptions {
  /**
   * Cap pauses longer than this many seconds. A real session spends most of its time
   * waiting — an agent turn, a build — and rendering that dead air at wall-clock speed
   * makes a GIF nobody watches. Pass null to keep the original timing.
   */
  idleTimeLimit?: number | null;
  /** Playback speed multiplier, e.g. 1.5 for half again as fast. */
  speed?: number;
  /**
   * Render only part of the recording, as `agg`'s `--select` range in seconds:
   * "40:" from 40s on, ":90" up to 90s, "40:90" between. `idleTimeLimit` cannot do this —
   * a spinner redrawing for a minute is never idle — so cutting a range is the only way
   * to drop a stretch that is busy but not worth watching.
   *
   * Windowing happens at render time on purpose. Trimming the .cast itself by dropping
   * events corrupts a TUI stream: the emulator never sees the writes that built the
   * current screen and the frame renders garbled. Only re-stamping timestamps is safe,
   * and `agg` already does the right thing.
   */
  select?: string;
}

const DEFAULT_IDLE_TIME_LIMIT = 2;

export interface RecordingResult {
  castPath: string;
  durationSeconds: number;
  events: number;
}

/** Where recordings land when the caller does not name a path. */
export function defaultCastPath(sessionId: string): string {
  const dir = path.join(os.homedir(), ".termmirror", "recordings");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${sessionId}-${stamp}.cast`);
}

/**
 * Writes an asciicast v2 file (https://docs.asciinema.org/manual/asciicast/v2/) from a
 * session's output stream. The format is JSONL — a header object, then one
 * `[elapsed, code, data]` array per event — which is exactly the shape the pty already
 * hands us, so recording is a passive listener with no polling or extra process.
 */
export class Recorder {
  readonly castPath: string;
  private stream: WriteStream;
  private t0 = Date.now();
  private events = 0;
  private stopped = false;

  constructor(
    castPath: string,
    meta: { cols: number; rows: number; command: string },
    /** Subscribe to the session's output; returns the unsubscribe closure. */
    subscribe: (listener: (chunk: string) => void) => () => void,
  ) {
    this.castPath = castPath;
    mkdirSync(path.dirname(castPath), { recursive: true });
    this.stream = createWriteStream(castPath);
    this.stream.write(
      JSON.stringify({
        version: 2,
        width: meta.cols,
        height: meta.rows,
        timestamp: Math.floor(this.t0 / 1000),
        command: meta.command,
        env: { TERM: "xterm-256color" },
      }) + "\n",
    );
    this.unsubscribe = subscribe((chunk) => this.event("o", chunk));
  }

  private unsubscribe: () => void;

  private event(code: "o" | "r", data: string) {
    if (this.stopped) return;
    this.events++;
    this.stream.write(JSON.stringify([(Date.now() - this.t0) / 1000, code, data]) + "\n");
  }

  recordResize(cols: number, rows: number) {
    this.event("r", `${cols}x${rows}`);
  }

  async stop(): Promise<RecordingResult> {
    const result = {
      castPath: this.castPath,
      durationSeconds: (Date.now() - this.t0) / 1000,
      events: this.events,
    };
    if (this.stopped) return result;
    this.stopped = true;
    this.unsubscribe();
    this.stream.end();
    await once(this.stream, "close");
    return result;
  }
}

function run(cmd: string, args: string[], install: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) =>
      reject(
        new Error(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `"${cmd}" is not installed — install it with \`${install}\` to export this format.`
            : `${cmd} failed: ${err.message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
  });
}

/**
 * Render a .cast to gif or mp4. Both go through `agg`; mp4 then re-encodes the gif with
 * ffmpeg. Neither binary ships with this package, so a missing one throws a message the
 * caller surfaces alongside the .cast, which is always valid on its own.
 */
export async function exportRecording(
  castPath: string,
  format: "gif" | "mp4",
  output?: string,
  opts: ExportOptions = {},
): Promise<string> {
  if (typeof castPath !== "string" || castPath === "") {
    throw new Error(
      "exportRecording needs the path to a .cast file. stopRecording() returns it as `castPath` " +
        `(got ${JSON.stringify(castPath)}).`,
    );
  }
  const base = castPath.replace(/\.cast$/, "");
  const gifPath = format === "gif" ? (output ?? `${base}.gif`) : `${base}.gif`;
  const idle = opts.idleTimeLimit === undefined ? DEFAULT_IDLE_TIME_LIMIT : opts.idleTimeLimit;
  const flags: string[] = [];
  if (idle !== null) flags.push("--idle-time-limit", String(idle));
  if (opts.speed) flags.push("--speed", String(opts.speed));
  if (opts.select) {
    if (!/^(\d+(\.\d+)?)?:(\d+(\.\d+)?)?$/.test(opts.select) || opts.select === ":") {
      throw new Error(
        `select must be a range of seconds like "40:", ":90" or "40:90" (got ${JSON.stringify(opts.select)}).`,
      );
    }
    flags.push("--select", opts.select);
  }
  await run("agg", [...flags, castPath, gifPath], "brew install agg");
  if (format === "gif") return gifPath;

  const mp4Path = output ?? `${base}.mp4`;
  // yuv420p + even dimensions keep the result playable in browsers and QuickTime.
  await run(
    "ffmpeg",
    ["-y", "-i", gifPath, "-movflags", "faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", mp4Path],
    "brew install ffmpeg",
  );
  return mp4Path;
}
