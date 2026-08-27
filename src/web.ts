import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionManager } from "./session.js";

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

export async function startWebUI(manager: SessionManager, port = 7878, host = "127.0.0.1"): Promise<WebUI> {
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
  wss.on("connection", (ws: WebSocket, req) => {
    const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
    let session;
    try {
      session = manager.get(id ?? "");
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
      ws.close();
      return;
    }

    ws.send(JSON.stringify({ type: "info", info: session.info() }));
    ws.send(JSON.stringify({ type: "output", data: session.replayBuffer() }));

    const off = session.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data: chunk }));
    });

    // Whatever the human types goes to the pty exactly as the agent's input would.
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input" && session.alive && !isTerminalReply(msg.data)) session.write(msg.data);
        if (msg.type === "resize") session.resize(msg.cols, msg.rows);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("close", off);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
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
