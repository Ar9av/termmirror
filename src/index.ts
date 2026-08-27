#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { SessionManager } from "./session.js";

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
