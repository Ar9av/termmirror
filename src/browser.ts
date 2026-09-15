import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { WaitResult } from "./session.js";

export interface BrowserOptions {
  url?: string;
  width?: number;
  height?: number;
  headless?: boolean;
  /**
   * Named on-disk Chrome profile, kept under ~/.termmirror/profiles. Logins survive into the
   * next session. Left unset the browser starts clean, which is also the only way two sessions
   * can run at once — Chrome refuses to open the same profile directory twice.
   */
  profile?: string;
}

export type ActionKind = "click" | "type" | "press" | "hover" | "select" | "scroll" | "upload";

export interface Action {
  kind: ActionKind;
  /** An `[ref=e12]` from the last snapshot, or a CSS selector. */
  target?: string;
  text?: string;
  key?: string;
  amount?: number;
  enter?: boolean;
  /** Local paths for `upload`. */
  files?: string[];
  /**
   * What to do with a dialog this action raises. A dialog blocks the page until it is
   * answered, so the answer has to be decided before the action runs, not after.
   */
  dialog?: "accept" | "dismiss";
  /** Text for a prompt() this action accepts. */
  dialogText?: string;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/** Refs the accessibility snapshot hands out: `e12`, or `f2e7` inside an iframe. */
const REF = /^(f\d+)?e\d+$/;

/** Characters of tree a snapshot returns before it is cut, roughly 4k tokens. */
const SNAPSHOT_LIMIT = 16_000;

export function defaultVideoPath(sessionId: string): string {
  const dir = path.join(os.homedir(), ".termmirror", "recordings");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${sessionId}-${stamp}.webm`);
}

/**
 * A browser the agent drives and a human can watch — the same contract as a terminal session.
 *
 * Driving is by accessibility ref rather than by pixel: `snapshot()` returns the tree with a
 * `[ref=eN]` on every node, and `act()` resolves those refs back to elements. That is what
 * makes a click deterministic without a vision model in the loop.
 *
 * Watching and recording are the same mechanism, a CDP screencast of JPEG frames. Only one
 * screencast can be open on a page, so every change to who wants frames — a viewer arriving,
 * a recording starting, the active tab changing — goes through syncCast(), which is the single
 * place that decides whether a screencast should be open, on which page, and with what options.
 */
export class BrowserSession {
  readonly id: string;
  readonly startedAt = new Date();
  readonly width: number;
  readonly height: number;

  alive = true;
  recording: string | null = null;

  private browser: Browser | null = null;
  private context: BrowserContext;
  private page: Page;
  private listeners = new Set<(jpegBase64: string) => void>();
  /** Latest frame, so a viewer that connects mid-session sees the page immediately. */
  private lastFrame: string | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private actionOverlay: { dispose: () => Promise<void> } | null = null;
  /** Which page the open screencast belongs to, and whether it is writing a file. */
  private castPage: Page | null = null;
  private castRecording = false;
  /**
   * A recording is one file per page it followed. Switching tabs has to close the screencast
   * and open another, and a video cannot be reopened, so the segments are joined at export.
   */
  private segments: string[] = [];

  /** Files the page downloaded, saved under ~/.termmirror/downloads/<session>. */
  readonly downloads: string[] = [];
  /** Downloads not yet reported in a snapshot. */
  private newDownloads: string[] = [];
  /** The last dialog the page raised and what was done with it, reported once then cleared. */
  private lastDialog: string | null = null;
  /** How the dialog raised by the action now running should be answered. */
  private dialogAction: "accept" | "dismiss" = "dismiss";
  private dialogText: string | undefined;

  private constructor(id: string, ctx: BrowserContext, page: Page, browser: Browser | null, w: number, h: number) {
    this.id = id;
    this.context = ctx;
    this.page = page;
    this.browser = browser;
    this.width = w;
    this.height = h;
  }

  /**
   * Everything that has to be true of every page, not just the first: a link with
   * `target="_blank"`, a sign-in popup and a tab the human opened all arrive here.
   */
  private attach(page: Page) {
    // A dialog blocks the page until it is answered, and Playwright only auto-dismisses while
    // nothing is listening. Once we listen, answering is ours to do — every path below has to
    // end in accept or dismiss, or the page hangs forever.
    page.on("dialog", async (d) => {
      const answer = d.type() === "beforeunload" ? "accept" : this.dialogAction;
      this.lastDialog = `${d.type()} "${d.message()}" was ${answer === "accept" ? "accepted" : "dismissed"}`;
      try {
        if (answer === "accept") await d.accept(this.dialogText);
        else await d.dismiss();
      } catch {
        /* the page went away while the dialog was open */
      }
    });

    page.on("download", async (d) => {
      try {
        const dir = path.join(os.homedir(), ".termmirror", "downloads", this.id);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, d.suggestedFilename() || "download");
        await d.saveAs(file);
        this.downloads.push(file);
        this.newDownloads.push(file);
      } catch {
        // A download that failed to save is reported by not appearing in the list.
      }
    });

    page.on("close", () => {
      if (page !== this.page) return;
      // The tab being driven closed itself. Fall back to another one rather than leaving the
      // session pointing at a dead page; with none left, the session is over.
      const left = this.openPages();
      if (left.length === 0) {
        this.alive = false;
        return;
      }
      this.page = left[left.length - 1];
      void this.syncCast();
    });
  }

  private openPages(): Page[] {
    return this.context.pages().filter((p) => !p.isClosed());
  }

  static async launch(id: string, opts: BrowserOptions = {}): Promise<BrowserSession> {
    const width = opts.width ?? 1280;
    const height = opts.height ?? 800;
    const viewport = { width, height };
    // `channel: "chrome"` uses the Chrome already installed on the machine, so this package
    // never downloads a browser of its own.
    const launch = { channel: "chrome", headless: opts.headless ?? false };

    let context: BrowserContext;
    let browser: Browser | null = null;
    try {
      if (opts.profile) {
        const dir = path.join(os.homedir(), ".termmirror", "profiles", opts.profile);
        mkdirSync(dir, { recursive: true });
        context = await chromium.launchPersistentContext(dir, { ...launch, viewport, acceptDownloads: true });
      } else {
        browser = await chromium.launch(launch);
        context = await browser.newContext({ viewport, acceptDownloads: true });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/executable doesn't exist|channel.*chrome|Chromium distribution/i.test(reason)) {
        throw new Error(
          "Google Chrome was not found — termmirror drives the Chrome you already have rather " +
            `than downloading its own. Install it from https://google.com/chrome. (${reason})`,
        );
      }
      throw err;
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(viewport).catch(() => {});
    const session = new BrowserSession(id, context, page, browser, width, height);

    session.attach(page);
    // A click with target="_blank", a sign-in popup, a tab the human opened: the new page
    // becomes the one being driven, because that is invariably what the click was for, and
    // an agent left talking to the page underneath has no way to notice.
    context.on("page", (opened) => {
      session.attach(opened);
      void opened
        .setViewportSize(viewport)
        .catch(() => {})
        .then(() => {
          session.page = opened;
          return session.syncCast();
        });
    });

    if (opts.url) await session.navigate(opts.url);
    return session;
  }

  /** Every open tab, in the order Chrome holds them. A title costs a round trip per page. */
  async tabList(): Promise<TabInfo[]> {
    const pages = this.openPages();
    return Promise.all(
      pages.map(async (p, index) => ({
        index,
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: p === this.page,
      })),
    );
  }

  async selectTab(index: number) {
    const pages = this.openPages();
    const page = pages[index];
    if (!page) throw new Error(`No tab ${index}. Open tabs: 0-${Math.max(pages.length - 1, 0)}.`);
    this.page = page;
    await page.bringToFront().catch(() => {});
    await this.syncCast();
  }

  async newTab(url?: string) {
    const page = await this.context.newPage();
    // The "page" event also adopts this one, but it lands a tick later. Taking it here means
    // the navigate below cannot race it and load the URL into the tab we came from.
    this.page = page;
    await page.setViewportSize({ width: this.width, height: this.height }).catch(() => {});
    if (url) await this.navigate(url);
    await this.syncCast();
    return page;
  }

  async closeTab(index: number) {
    const pages = this.openPages();
    const page = pages[index];
    if (!page) throw new Error(`No tab ${index}. Open tabs: 0-${Math.max(pages.length - 1, 0)}.`);
    await page.close();
  }

  get url(): string {
    return this.page.url();
  }

  async navigate(url: string) {
    const full = /^[a-z]+:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("data:") ? url : `https://${url}`;
    await this.page.goto(full, { waitUntil: "domcontentloaded" });
  }

  /**
   * The accessibility tree with a `[ref=eN]` on every node — what `act` targets resolve against.
   *
   * Capped by default. A news front page is ~12k tokens of tree and a Wikipedia article ~34k,
   * and every action returns one of these, so an uncapped snapshot would cost more per click
   * than most agents can afford. `depth` is the real fix for a big page; `full` is for when
   * the whole thing is genuinely wanted.
   */
  async snapshot(depth?: number, full = false): Promise<string> {
    let tree = await this.page.ariaSnapshot({ mode: "ai", ...(depth ? { depth } : {}) });
    const notes: string[] = [];

    if (!full && tree.length > SNAPSHOT_LIMIT) {
      // Cut on a line boundary so no node is left half-written, and say what was left out.
      const cut = tree.lastIndexOf("\n", SNAPSHOT_LIMIT);
      const dropped = tree.slice(cut).split("\n").length - 1;
      tree = tree.slice(0, cut);
      notes.push(
        `showing the first ${tree.split("\n").length} lines of the tree, ${dropped} more not shown — ` +
          "pass `depth` to keep it short, or `full: true` for all of it",
      );
    }

    const pages = this.openPages();
    if (pages.length > 1) {
      notes.push(`tab ${pages.indexOf(this.page)} of ${pages.length} — browser_tabs lists them`);
    }
    // Things that happened to the page rather than in it, and would otherwise be invisible in
    // a tree of elements. Each is reported once, on the next look at the page.
    if (this.lastDialog) {
      notes.push(this.lastDialog);
      this.lastDialog = null;
    }
    if (this.newDownloads.length) {
      notes.push(`downloaded ${this.newDownloads.join(", ")}`);
      this.newDownloads.length = 0;
    }

    const header = notes.map((n) => `[${this.id}: ${n}]\n`).join("");
    // A data: URL is the whole page; a tracking URL can run to thousands of characters. The
    // agent needs to know where it is, not to read the address back in full.
    const url = this.page.url();
    const where = url.length > 200 ? `${url.slice(0, 200)}… (${url.length} chars)` : url;
    return `[${this.id}] ${where}\n${header}${tree}`;
  }

  async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "jpeg", quality: 70 });
    return buf.toString("base64");
  }

  private locator(target: string) {
    return REF.test(target) ? this.page.locator(`aria-ref=${target}`) : this.page.locator(target);
  }

  async act(a: Action): Promise<void> {
    const need = (what: string) => {
      if (!a.target) throw new Error(`act kind "${a.kind}" needs a target (a ref like "e12" or a CSS selector) to ${what}.`);
      return this.locator(a.target);
    };
    // The dialog handler is a listener, so it cannot be told what to do at the moment it
    // fires. Set the answer before the action that might raise one, and put it back after.
    this.dialogAction = a.dialog ?? "dismiss";
    this.dialogText = a.dialogText;
    try {
      await this.perform(a, need);
    } finally {
      this.dialogAction = "dismiss";
      this.dialogText = undefined;
    }
  }

  private async perform(a: Action, need: (what: string) => ReturnType<BrowserSession["locator"]>): Promise<void> {
    switch (a.kind) {
      case "click":
        await need("click").click();
        break;
      case "type": {
        const el = need("type into");
        await el.fill(a.text ?? "");
        if (a.enter) await el.press("Enter");
        break;
      }
      case "press": {
        if (!a.key) throw new Error('act kind "press" needs `key`, e.g. "Enter", "Escape", "ArrowDown", "Control+a".');
        if (a.target) await this.locator(a.target).press(a.key);
        else await this.page.keyboard.press(a.key);
        break;
      }
      case "hover":
        await need("hover").hover();
        break;
      case "select":
        if (a.text === undefined) throw new Error('act kind "select" needs `text`: the option to choose.');
        await need("select in").selectOption(a.text);
        break;
      case "scroll":
        if (a.target) await this.locator(a.target).scrollIntoViewIfNeeded();
        else await this.page.mouse.wheel(0, a.amount ?? this.height * 0.8);
        break;
      case "upload": {
        if (!a.files?.length) throw new Error('act kind "upload" needs `files`: local paths to attach.');
        const missing = a.files.filter((f) => !existsSync(f));
        // Playwright reports a missing file from inside the browser, where the message says
        // nothing about which path was wrong.
        if (missing.length) throw new Error(`no such file: ${missing.join(", ")}`);
        await need("upload to").setInputFiles(a.files);
        break;
      }
    }
  }

  async waitIdle(timeoutMs: number): Promise<WaitResult> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: timeoutMs });
      return { ok: true, reason: "idle" };
    } catch {
      // Pages with a long-lived socket never go quiet; that is not a failure to report as one.
      return { ok: true, reason: "timeout", note: "the page never went network-idle — it may hold an open connection" };
    }
  }

  async waitPattern(pattern: string, timeoutMs: number, ignoreCase = false): Promise<WaitResult> {
    try {
      await this.page.waitForFunction(
        ([src, flags]) => new RegExp(src, flags).test(document.body?.innerText ?? ""),
        [pattern, ignoreCase ? "i" : ""],
        { timeout: timeoutMs },
      );
      return { ok: true, reason: "pattern", match: pattern };
    } catch {
      return { ok: false, reason: "timeout" };
    }
  }

  /**
   * Human takeover, through the same page object the agent uses — neither side needs to know
   * about the other.
   *
   * `x` and `y` are fractions of the viewport, not pixels. The viewer sees the page twice
   * scaled: the screencast frame comes back smaller than the viewport it was captured from,
   * and the page then draws that frame at whatever size fits the panel. A fraction is the one
   * form that survives both, and this is the end that knows the viewport it converts back to.
   */
  async input(msg: { type: string; x?: number; y?: number; dy?: number; key?: string; text?: string }) {
    if (!this.alive) return;
    const px = (f: number) => f * this.width;
    const py = (f: number) => f * this.height;

    if (msg.type === "click" && msg.x !== undefined && msg.y !== undefined) {
      await this.page.mouse.click(px(msg.x), py(msg.y));
    } else if (msg.type === "wheel" && msg.x !== undefined && msg.y !== undefined) {
      await this.page.mouse.move(px(msg.x), py(msg.y));
      await this.page.mouse.wheel(0, msg.dy ?? 0);
    } else if (msg.type === "text" && msg.text) {
      await this.page.keyboard.insertText(msg.text);
    } else if (msg.type === "key" && msg.key) {
      await this.page.keyboard.press(msg.key);
    }
  }

  onFrame(listener: (jpegBase64: string) => void): () => void {
    this.listeners.add(listener);
    if (this.lastFrame) listener(this.lastFrame);
    void this.syncCast();
    return () => {
      this.listeners.delete(listener);
      void this.syncCast();
    };
  }

  /**
   * Resolves once the screencast is actually writing, or throws — a recording that silently
   * never started would otherwise only be discovered when the renderer cannot find the file.
   */
  async startRecording(videoPath?: string): Promise<string> {
    if (this.recording) return this.recording;
    const target = videoPath ?? defaultVideoPath(this.id);
    // Playwright accepts any path at start and reports nothing at stop when it cannot write
    // there, so the one moment to find out is now.
    try {
      mkdirSync(path.dirname(target), { recursive: true });
    } catch (err) {
      throw new Error(`could not start recording ${this.id}: cannot create ${path.dirname(target)} (${(err as Error).message})`);
    }
    this.recording = target;
    this.segments = [];
    await this.syncCast();
    if (!this.castRecording) {
      const why = this.castError ?? "the screencast did not start";
      this.recording = null;
      throw new Error(`could not start recording ${this.id}: ${why}`);
    }
    return this.recording;
  }

  async stopRecording(): Promise<{ videoPath: string; segments: string[] } | null> {
    if (!this.recording) return null;
    this.recording = null;
    // Closes the screencast, which is what writes the final segment to disk.
    await this.syncCast();
    // stop() does not say when it failed to write, so the file's existence is the only word.
    const segments = this.segments.filter((f) => existsSync(f));
    this.segments = [];
    if (segments.length === 0) {
      throw new Error(`nothing was recorded for ${this.id}: ${this.castError ?? "no video file was written"}`);
    }
    return { videoPath: segments[0], segments };
  }

  /**
   * The one place that opens or closes the screencast. Serialised through a promise chain
   * because a viewer connecting while a recording starts, or a popup stealing the active
   * tab mid-recording, would otherwise race two start/stop pairs against a page that allows
   * only one screencast at a time.
   */
  private syncCast(): Promise<void> {
    this.syncing = this.syncing.then(() => this.applyCast()).catch(() => {});
    return this.syncing;
  }

  /** Why the last attempt to open a screencast failed, for the error a caller sees. */
  private castError: string | null = null;
  private castRetries = 0;

  /** Where the next stretch of video goes. The first one is the path the caller asked for. */
  private nextSegment(): string {
    const asked = this.recording!;
    if (this.segments.length === 0) return asked;
    return `${asked.replace(/\.webm$/, "")}-${this.segments.length + 1}.webm`;
  }

  private async applyCast() {
    const want = this.alive && (this.recording !== null || this.listeners.size > 0);
    const recording = this.recording !== null;
    // A screencast belongs to one page. If the active tab changed, the old one has to be
    // closed and another opened, even though nothing about who wants frames has changed.
    const stale = this.castPage !== null && (!want || this.castPage !== this.page || this.castRecording !== recording);

    if (stale) {
      await this.castPage!.screencast.stop().catch(() => {});
      this.castPage = null;
      this.castRecording = false;
      if (this.actionOverlay) {
        await this.actionOverlay.dispose().catch(() => {});
        this.actionOverlay = null;
      }
    }
    if (!want || this.castPage) return;

    const page = this.page;
    const segment = recording ? this.nextSegment() : null;
    if (recording) {
      // Draws the cursor and highlights what was clicked, so the video shows the agent working
      // rather than a page that changes for no visible reason.
      this.actionOverlay = await page.screencast.showActions({ cursor: "pointer" }).catch(() => null);
    }
    try {
      await page.screencast.start({
        quality: 60,
        ...(segment ? { path: segment } : {}),
        onFrame: ({ data }) => {
          this.lastFrame = data.toString("base64");
          for (const l of this.listeners) l(this.lastFrame);
        },
      });
    } catch (err) {
      // Usually the page was mid-navigation. Without a retry a viewer who connected at that
      // moment would see nothing until something else happened to nudge the screencast.
      this.castError = err instanceof Error ? err.message : String(err);
      if (this.castRetries++ < 3) setTimeout(() => void this.syncCast(), 500);
      return;
    }
    this.castError = null;
    this.castRetries = 0;
    this.castPage = page;
    this.castRecording = recording;
    if (segment) this.segments.push(segment);
  }

  async kill() {
    await this.stopRecording();
    this.alive = false;
    this.listeners.clear();
    await this.context.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  info() {
    return {
      id: this.id,
      kind: "browser" as const,
      command: this.alive ? this.page.url() : "(closed)",
      url: this.alive ? this.page.url() : null,
      width: this.width,
      height: this.height,
      alive: this.alive,
      startedAt: this.startedAt.toISOString(),
      recording: this.recording,
    };
  }
}
