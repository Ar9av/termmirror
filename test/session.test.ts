import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SessionManager } from "../src/session.js";
import { keyToSequence } from "../src/keys.js";

const mgr = new SessionManager();
after(() => mgr.killAll());

test("runs a command and reads it back off the screen", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);
  s.write("echo hello-from-pty\r");
  const w = await s.waitIdle(300, 5000);
  assert.equal(w.reason, "idle");
  assert.match(await s.screen(), /hello-from-pty/);
  await mgr.remove(s.id);
});

test("wait holds for output that arrives late, not just for current quiet", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  // Echo off models the case that matters: a raw-mode TUI, where input produces no
  // output of its own and the only thing to wait for is the program's reaction,
  // which lands a second later. The session is already quiet when the wait starts.
  s.write("stty -echo\r");
  await s.waitIdle(300, 5000);
  s.write("sleep 1; printf 'set%s\\n' tled\r");
  const w = await s.waitIdle(300, 10000);
  assert.equal(w.reason, "idle");
  assert.match(await s.screen(), /settled/);
  await mgr.remove(s.id);
});

test("wait returns promptly when the reply beat the call", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  await s.waitIdle(300, 5000);
  s.write("echo quick\r");
  // send_input and wait reach the server as separate calls, so the program has
  // usually already answered by the time the wait starts.
  await new Promise((r) => setTimeout(r, 1500));
  const started = Date.now();
  const w = await s.waitIdle(300, 8000);
  assert.equal(w.reason, "idle");
  assert.ok(Date.now() - started < 1000, `should not stall waiting for output it already got`);
  await mgr.remove(s.id);
});

test("wait reports no_output when input drew no response", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  s.write("stty -echo\r");
  await s.waitIdle(300, 5000);
  s.write("x"); // echo is off and there is no newline, so nothing comes back
  const w = await s.waitIdle(300, 900);
  assert.equal(w.ok, false);
  assert.equal(w.reason, "no_output");
  await mgr.remove(s.id);
});

test("waitPattern resolves on program output", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  s.write("sleep 0.3; echo READY\r");
  const w = await s.waitPattern("READY", 5000);
  assert.ok(w.ok, "pattern should match before timeout");
  await mgr.remove(s.id);
});

test("waitPattern reports timeout rather than hanging", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  const w = await s.waitPattern("never-appears-xyz", 400);
  assert.equal(w.ok, false);
  assert.equal(w.reason, "timeout");
  await mgr.remove(s.id);
});

test("scrollback returns lines that scrolled off the screen", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 10 });
  await s.waitIdle(300, 5000);
  s.write("for i in $(seq 1 40); do echo line-$i; done\r");
  await s.waitIdle(400, 5000);
  const screen = await s.screen();
  assert.doesNotMatch(screen, /line-1\b/, "line-1 should have scrolled away");
  assert.match(await s.scrollback(60), /line-1\b/, "scrollback should still hold it");
  await mgr.remove(s.id);
});

test("exit is observed and further writes are refused", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile", "-c", "exit 3"] });
  const w = await s.waitIdle(200, 5000);
  assert.equal(w.reason, "exited");
  assert.equal(s.alive, false);
  assert.equal(s.exitCode, 3);
  assert.throws(() => s.write("x"), /has exited/);
});

test("spawning works even if the pty helper lost its executable bit", async () => {
  // Reproduces an --ignore-scripts install, and npm v12's scripts-off default: strip the
  // bit that node-pty's spawn-helper needs and confirm the session repairs it itself
  // rather than failing with "posix_spawnp failed".
  const require = createRequire(import.meta.url);
  const root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  const helpers = [
    path.join(root, "build", "Release", "spawn-helper"),
    ...(existsSync(path.join(root, "prebuilds"))
      ? readdirSync(path.join(root, "prebuilds")).map((p) => path.join(root, "prebuilds", p, "spawn-helper"))
      : []),
  ].filter(existsSync);

  assert.ok(helpers.length > 0, "expected at least one spawn-helper to test against");
  const original = helpers.map((h) => [h, statSync(h).mode] as const);
  for (const [h] of original) chmodSync(h, 0o644);

  try {
    const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
    await s.waitIdle(300, 5000);
    s.write("echo self-healed\r");
    await s.waitIdle(300, 5000);
    assert.match(await s.screen(), /self-healed/);
    await mgr.remove(s.id);
  } finally {
    for (const [h, mode] of original) chmodSync(h, mode);
  }
});

test("key names map to escape sequences", () => {
  assert.equal(keyToSequence("ctrl+c"), "\x03");
  assert.equal(keyToSequence("C-c"), "\x03");
  assert.equal(keyToSequence("up"), "\x1b[A");
  assert.equal(keyToSequence("escape"), "\x1b");
  assert.equal(keyToSequence("alt+f"), "\x1bf");
  assert.equal(keyToSequence("a"), "a");
  assert.throws(() => keyToSequence("wat"), /Unknown key/);
});
