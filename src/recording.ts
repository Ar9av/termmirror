import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

export type Format = "cast" | "gif" | "mp4";

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
export async function exportRecording(castPath: string, format: "gif" | "mp4", output?: string): Promise<string> {
  const base = castPath.replace(/\.cast$/, "");
  const gifPath = format === "gif" ? (output ?? `${base}.gif`) : `${base}.gif`;
  await run("agg", [castPath, gifPath], "brew install agg");
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
