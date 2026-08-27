import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

function textOf(res: any): string {
  return res.content.map((c: any) => c.text).join("\n");
}

test("exits when the client disconnects instead of orphaning sessions", async () => {
  const child = spawn(process.execPath, ["dist/src/index.js"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, TERMINAL_UI_PORT: "0" },
  });

  // Open a session so the pty and the web server are both holding the loop open.
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_session", arguments: { command: "/bin/bash", args: ["--norc", "--noprofile"] } },
  };
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n",
  );
  await new Promise((r) => child.stdout.once("data", r));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify(request) + "\n");
  await new Promise((r) => child.stdout.once("data", r));

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.stdin.end();

  const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]);
  assert.notEqual(outcome, "still running", "server must exit when stdin closes");
});

test("drives a session end to end over the MCP protocol", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/src/index.js"],
      env: { ...process.env, TERMINAL_UI_PORT: "0" } as Record<string, string>,
    }),
  );

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "create_session",
    "kill_session",
    "list_sessions",
    "read_screen",
    "resize",
    "send_input",
    "send_keys",
    "wait",
  ]);

  const created = JSON.parse(
    textOf(await client.callTool({ name: "create_session", arguments: { command: "/bin/bash", args: ["--norc", "--noprofile"] } })),
  );
  const session = created.id;
  assert.match(created.watchUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?session=/, "should hand back a watch URL");

  await client.callTool({ name: "wait", arguments: { session, idle_ms: 300, timeout: 5000 } });
  await client.callTool({ name: "send_input", arguments: { session, text: "echo mcp-works", enter: true } });
  await client.callTool({ name: "wait", arguments: { session, idle_ms: 300, timeout: 5000 } });

  const screen = textOf(await client.callTool({ name: "read_screen", arguments: { session } }));
  assert.match(screen, /mcp-works/);

  // ctrl+c must reach the program: interrupt a sleep and get the prompt back.
  await client.callTool({ name: "send_input", arguments: { session, text: "sleep 30", enter: true } });
  await client.callTool({ name: "send_keys", arguments: { session, keys: ["ctrl+c"] } });
  const after = await client.callTool({ name: "wait", arguments: { session, idle_ms: 300, timeout: 5000 } });
  assert.equal(JSON.parse(textOf(after)).ok, true, "session should go quiet after the interrupt");

  const listed = JSON.parse(textOf(await client.callTool({ name: "list_sessions", arguments: {} })));
  assert.equal(listed.sessions.length, 1);

  await client.callTool({ name: "kill_session", arguments: { session } });
  const empty = JSON.parse(textOf(await client.callTool({ name: "list_sessions", arguments: {} })));
  assert.equal(empty.sessions.length, 0);

  await client.close();
});
