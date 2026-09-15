import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { Session, SessionManager } from "./session.js";
import type { BrowserSession } from "./browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

// Served straight out of node_modules so the page has no CDN dependency.
const ASSETS: Record<string, { file: string; type: string }> = {
  "/index.html": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/xterm.css": { file: "node_modules/@xterm/xterm/css/xterm.css", type: "text/css" },
  "/xterm.js": { file: "node_modules/@xterm/xterm/lib/xterm.js", type: "text/javascript" },
};

/**
 * The browser's terminal answers device queries too, and the headless one has already
 * answered them — a program that asks would get each answer twice while someone is
 * watching. These shapes are replies, never anything a person can type, so dropping
 * them leaves the headless emulator as the single voice of the terminal. Bracketed
 * paste (ESC[200~) ends in `~` and is deliberately not matched.
 */
function isTerminalReply(data: unknown): boolean {
  return typeof data === "string" && /^\x1b(?:\[[?>]?[0-9;]*[cnRu]|\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\))$/.test(data);
}

export interface WebUI {
  url: string;
  sessionUrl(id: string): string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7878;

export async function startWebUI(manager: SessionManager, port?: number, host = "127.0.0.1"): Promise<WebUI> {
  // An explicit port is a request to be somewhere specific, so a collision there is an
  // error. The default is just a convention, and the thing most likely to be sitting on
  // it is another termmirror that outlived its client — no reason to lose the viewer
  // over that when any free port serves the page just as well.
  const wanted = port ?? DEFAULT_PORT;
  const strict = port !== undefined;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = url.pathname === "/" ? "/index.html" : url.pathname;

    if (key === "/api/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manager.list().map((s) => s.info())));
      return;
    }

    const asset = ASSETS[key];
    if (!asset) {
      res.writeHead(404).end("not found");
      return;
    }
    fs.readFile(path.join(root, asset.file), (err, body) => {
      if (err) res.writeHead(500).end(String(err));
      else res.writeHead(200, { "content-type": asset.type }).end(body);
    });
  });

  const wss = new WebSocketServer({ server });
  // ws mirrors the http server's errors onto itself, and an unhandled 'error' event is
  // fatal to the whole process — a busy port would take the MCP server down with it
  // before the listen below ever got to handle the failure itself.
  wss.on("error", () => {});
  wss.on("connection", (ws: WebSocket, req) => {
    const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
    let session;
    try {
      session = manager.any(id ?? "");
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
      ws.close();
      return;
    }

    if (session.info().kind === "browser") {
      const browser = session as BrowserSession;
      ws.send(JSON.stringify({ type: "info", info: browser.info() }));
      // A browser mirrors as JPEG frames rather than a byte stream, and whatever the human
      // clicks or types goes to the same page the agent is driving — no arbitration, exactly
      // as typing into a terminal session works.
      const stop = browser.onFrame((data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "frame", data }));
      });
      ws.on("message", (raw) => {
        try {
          void browser.input(JSON.parse(raw.toString()));
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on("close", stop);
      return;
    }

    const term = session as Session;
    ws.send(JSON.stringify({ type: "info", info: term.info() }));
    ws.send(JSON.stringify({ type: "output", data: term.replayBuffer() }));

    const off = term.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data: chunk }));
    });

    // Whatever the human types goes to the pty exactly as the agent's input would.
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input" && term.alive && !isTerminalReply(msg.data)) term.write(msg.data);
        if (msg.type === "resize") term.resize(msg.cols, msg.rows);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("close", off);
  });

  const bind = (p: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once("error", onError);
      server.listen(p, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

  try {
    await bind(wanted);
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!busy || strict) {
      if (busy) {
        throw new Error(
          `port ${wanted} is already in use. If you did not set TERMINAL_UI_PORT, a termmirror ` +
            `from an earlier session may still be holding it — check with \`lsof -ti :${wanted}\`.`,
        );
      }
      throw err;
    }
    await bind(0);
  }

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : wanted;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    sessionUrl: (id) => `${url}/?session=${encodeURIComponent(id)}`,
    close: () =>
      new Promise((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}
