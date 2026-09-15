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
  // A raw-mode TUI is the case that matters: input draws nothing of its own and the only
  // thing to wait for is a reaction that lands a second later. `stty -echo` under an
  // interactive shell does not model that — readline turns echo back on at every prompt —
  // so the shell execs into a reader with echo already off and never prompts again.
  const s = mgr.create({
    command: "/bin/bash",
    args: ["--norc", "--noprofile", "-c", "stty -echo; read line; sleep 1; echo settled; read done"],
  });
  await s.type("go", true);
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

test("type waits for a noisy program to go quiet before typing", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);
  s.write("for i in 1 2 3 4 5; do echo noise-$i; sleep 0.1; done; read answer && echo got:$answer\r");
  await s.waitPattern("noise-1", 5000);

  const start = Date.now();
  await s.type("green", true);
  // It must at least sit through one quiet period rather than typing straight into the burst.
  assert.ok(Date.now() - start >= 200, "should have waited for quiet");
  await s.waitIdle(400, 5000);
  assert.match(await s.screen(), /got:green/);
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

test("a pty that dies mid-reply does not wedge the emulator", async () => {
  // The reply handler runs inside xterm's parser. A throw there escapes xterm's write
  // loop, and that loop only reschedules itself when its queue is empty — which it is
  // not — so every later chunk queues forever: a frozen screen on a session that still
  // reports alive and still accepts input. Writing to an exited pty is that throw.
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);

  // Force the handler to throw on every reply, whatever the pty's real state is.
  (s as unknown as { proc: { write(d: string): void } }).proc.write = () => {
    throw new Error("Cannot call write after the socket is closed");
  };

  // A device-attributes query makes the emulator answer, tripping the throw.
  (s as unknown as { term: { write(d: string): void } }).term.write("\x1b[c");
  await new Promise((r) => setTimeout(r, 100));

  // The screen must still accept output afterwards.
  (s as unknown as { term: { write(d: string): void } }).term.write("still-alive\r\n");
  assert.match(await s.screen(), /still-alive/, "emulator wedged: later output never landed");
  assert.equal(s.staleReason, null, "screen should not be reported stale");
  await mgr.remove(s.id);
});

test("a wedged emulator reports the screen as stale instead of hanging", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);

  // Wedge it directly: swallow the flush callback the way a dead write loop does.
  (s as unknown as { term: { write(d: string, cb?: () => void): void } }).term.write = () => {};

  const started = Date.now();
  const screen = await s.screen();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 4000, `screen() should time out, took ${elapsed}ms`);
  assert.equal(typeof screen, "string");
  assert.match(String(s.staleReason), /frozen/, "the freeze must be reported, not hidden");
  await mgr.remove(s.id);
});
