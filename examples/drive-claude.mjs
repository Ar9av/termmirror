#!/usr/bin/env node
// The flagship case, written out longhand: one agent driving another agent's CLI.
// Over MCP this is the same four tools — create_session, send_keys/send_input, wait, read_screen.
//
//   node examples/drive-claude.mjs "what is 2+2"

import { SessionManager } from "../dist/src/session.js";
import { startWebUI } from "../dist/src/web.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const prompt = process.argv[2] ?? "what is 2+2? reply with just the number";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "drive-claude-"));

const manager = new SessionManager();
const web = await startWebUI(manager);
const session = manager.create({ command: "claude", cwd, cols: 100, rows: 30 });
console.log(`watch it live: ${web.sessionUrl(session.id)}\n`);

const settle = async (label, idleMs = 4000, timeout = 120_000) => {
  const r = await session.waitIdle(idleMs, timeout);
  console.log(`--- ${label} (${r.reason}) ---\n${await session.screen()}\n`);
  return r;
};

await settle("startup");

// A fresh directory means claude opens on its trust prompt; Enter accepts the default.
if (/trust this folder/i.test(await session.screen())) {
  await session.type("", true);
  await settle("after trusting the folder");
}

// type() rather than write(): it holds off until the composer stops redrawing, since keys
// that arrive mid-redraw are dropped without a trace.
await session.type(prompt, true);
// It redraws constantly while thinking, so silence is the signal that the turn is over.
await settle("after asking");

await manager.killAll();
await web.close();
fs.rmSync(cwd, { recursive: true, force: true });
