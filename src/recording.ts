import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
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

/**
 * Join the segments a recording was split into when it followed the page from tab to tab.
 * Every segment came from the same encoder at the same viewport, so they concatenate without
 * re-encoding. Returns the single file to render from.
 */
export async function concatVideos(segments: string[]): Promise<string> {
  if (segments.length < 2) return segments[0];
  const joined = segments[0].replace(/\.webm$/, "") + "-joined.webm";
  const list = joined.replace(/\.webm$/, ".txt");
  // The concat demuxer reads paths from a file; single quotes are its escape for them.
  writeFileSync(list, segments.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  try {
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined], "brew install ffmpeg");
    return joined;
  } finally {
    rmSync(list, { force: true });
  }
}

/**
 * Render a browser recording. A browser session records to .webm directly — there is no
 * asciicast for a page of pixels — so the conversion is ffmpeg alone, with no `agg` step.
 * `idleTimeLimit` and `select` have no equivalent here: a video has no event stream to
 * re-stamp, so trimming dead air would mean re-encoding by content rather than by timing.
 */
export async function exportVideo(
  videoPath: string,
  format: "gif" | "mp4",
  output?: string,
  opts: { speed?: number } = {},
): Promise<string> {
  const base = videoPath.replace(/\.webm$/, "");
  const target = output ?? `${base}.${format}`;
  const speed = opts.speed && opts.speed > 0 ? `setpts=PTS/${opts.speed},` : "";

  const filters =
    format === "gif"
      ? // A palette pass; without it a screenshot of a web page dithers into mush.
        `${speed}fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`
      : `${speed}scale=trunc(iw/2)*2:trunc(ih/2)*2`;

  // The gif chain splits the stream for the palette, so it needs filter_complex; mp4 is a
  // plain chain and -vf is what ffmpeg expects for that.
  const args = ["-y", "-i", videoPath, format === "gif" ? "-filter_complex" : "-vf", filters];
  if (format === "mp4") args.push("-movflags", "faststart", "-pix_fmt", "yuv420p");
  args.push(target);

  await run("ffmpeg", args, "brew install ffmpeg");
  return target;
}
