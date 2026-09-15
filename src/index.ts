#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// node-pty loads its native binding while the module is being evaluated, so this has to
// be a dynamic import to be catchable at all. On Linux there is no prebuilt binding — it
// is compiled at install time and skipped silently under `ignore-scripts=true` — and the
// only thing the user sees is "Failed to load native module: pty.node" with no hint that
// one rebuild fixes it.
let createServer, SessionManager;
try {
  ({ createServer } = await import("./mcp.js"));
  ({ SessionManager } = await import("./session.js"));
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  if (/native module|pty\.node|Cannot find module.*pty/i.test(reason)) {
    // stdout is the MCP channel; diagnostics belong on stderr, which is where the client
    // shows a server that failed to start.
    process.stderr.write(
      `termmirror: node-pty's native binding is missing, so no terminal can be started.\n` +
        `On Linux it is compiled during install and is skipped when npm runs with ` +
        `ignore-scripts=true. Build it once with:\n\n` +
        `  npm rebuild node-pty --foreground-scripts\n\n` +
        `That needs make, g++ and python3. Original error: ${reason}\n`,
    );
    process.exit(1);
  }
  throw err;
}

const port = process.env.TERMINAL_UI_PORT ? Number(process.env.TERMINAL_UI_PORT) : undefined;
const manager = new SessionManager();
const { server, close } = createServer(manager, { port, noWeb: process.env.TERMINAL_NO_UI === "1" });

// stdout is the MCP channel — anything logged there corrupts the protocol.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);

await server.connect(new StdioServerTransport());

// The client going away has to take the sessions and the web server with it, or every
// disconnect leaves orphaned processes and a held port behind. The stdio transport only
// watches stdin for data and errors, so the end of the pipe is ours to notice.
server.server.onclose = shutdown;
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
