import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session.js";
import { exportRecording } from "../src/recording.js";

const mgr = new SessionManager();
const tmp = mkdtempSync(path.join(os.tmpdir(), "termmirror-rec-"));
after(async () => {
  await mgr.killAll();
  rmSync(tmp, { recursive: true, force: true });
});

function readCast(file: string) {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return { header: JSON.parse(lines[0]), events: lines.slice(1).map((l) => JSON.parse(l)) };
}

test("records session output as an asciicast", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);

  const castPath = s.startRecording(path.join(tmp, "basic.cast"));
  assert.equal(s.recording, castPath);
  s.write("echo recorded-me\r");
  await s.waitIdle(300, 5000);
  const result = await s.stopRecording();

  assert.ok(result, "stopRecording should return a result while recording");
  assert.equal(s.recording, null);
  assert.ok(result.events > 0, "should have captured at least one output event");

  const { header, events } = readCast(castPath);
  assert.equal(header.version, 2);
  assert.equal(header.width, 80);
  assert.equal(header.height, 24);

  const output = events.filter((e) => e[1] === "o");
  assert.ok(output.length > 0, "expected output events");
  assert.ok(
    output.some((e) => e[0] >= 0 && typeof e[2] === "string"),
    "events should be [elapsed, code, data]",
  );
  assert.match(output.map((e) => e[2]).join(""), /recorded-me/);

  await mgr.remove(s.id);
});

test("resize is recorded and output before start_recording is not", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"], cols: 80, rows: 24 });
  await s.waitIdle(300, 5000);
  s.write("echo before-the-recording\r");
  await s.waitIdle(300, 5000);

  const castPath = s.startRecording(path.join(tmp, "resize.cast"));
  s.resize(100, 30);
  s.write("echo after-the-recording\r");
  await s.waitIdle(300, 5000);
  await s.stopRecording();

  const { events } = readCast(castPath);
  const body = events.map((e) => e[2]).join("");
  assert.doesNotMatch(body, /before-the-recording/, "recording should start where it was asked to");
  assert.match(body, /after-the-recording/);
  assert.ok(
    events.some((e) => e[1] === "r" && e[2] === "100x30"),
    "resize should be recorded so playback reflows",
  );

  await mgr.remove(s.id);
});

test("a recording is finalized when the process exits on its own", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  await s.waitIdle(300, 5000);
  const castPath = s.startRecording(path.join(tmp, "exit.cast"));
  s.write("exit 0\r");
  await s.waitIdle(300, 5000);
  // onExit finalizes asynchronously.
  for (let i = 0; i < 20 && s.recording; i++) await new Promise((r) => setTimeout(r, 50));

  assert.equal(s.recording, null, "exit should stop the recording");
  const { header, events } = readCast(castPath);
  assert.equal(header.version, 2);
  assert.match(events.map((e) => e[2]).join(""), /process exited with code 0/);
});

test("stopRecording returns null when nothing is recording", async () => {
  const s = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  assert.equal(await s.stopRecording(), null);
  await mgr.remove(s.id);
});

test("a missing renderer explains how to install it instead of failing silently", async () => {
  // agg is not installed in CI; when it is, the cast is bogus so agg still refuses.
  await assert.rejects(
    () => exportRecording(path.join(tmp, "does-not-exist.cast"), "gif"),
    /agg/,
    "should name the missing tool",
  );
});
