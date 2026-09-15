import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session.js";

const mgr = new SessionManager();
const tmp = mkdtempSync(path.join(os.tmpdir(), "termmirror-web-"));

// Chrome is the one thing this package does not ship. On a machine without it every test
// here would fail for a reason that has nothing to do with the code.
let haveChrome = true;
before(async () => {
  try {
    const s = await mgr.createBrowser({ headless: true, width: 600, height: 400 });
    await mgr.remove(s.id);
  } catch (err) {
    haveChrome = false;
    console.log(`skipping browser tests: ${err instanceof Error ? err.message : String(err)}`);
  }
});

after(async () => {
  await mgr.killAll();
  rmSync(tmp, { recursive: true, force: true });
});

const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<h1 id="t">start</h1>
     <button onclick="document.getElementById('t').textContent='clicked'">Go</button>
     <input aria-label="Name">
     <p id="echo"></p>
     <script>document.querySelector('input').oninput=e=>document.getElementById('echo').textContent='hi '+e.target.value</script>`,
  );

test("snapshots the page as an accessibility tree with refs", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });

  const snap = await b.snapshot();
  assert.match(snap, /heading "start".*\[ref=e\d+\]/, "heading should be in the tree with a ref");
  assert.match(snap, /button "Go".*\[ref=e\d+\]/, "button should be in the tree with a ref");

  await mgr.remove(b.id);
});

test("acts on the page by ref and by selector", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });

  const ref = (await b.snapshot()).match(/button "Go"[^\n]*\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  assert.ok(ref, "should have found a ref for the button");

  await b.act({ kind: "click", target: ref });
  assert.match(await b.snapshot(), /heading "clicked"/, "the click should have changed the heading");

  // A CSS selector is the other accepted target shape.
  await b.act({ kind: "type", target: "input", text: "there" });
  const after = await b.waitPattern("hi there", 5000);
  assert.equal(after.ok, true, "typing should have reached the page");

  await mgr.remove(b.id);
});

test("a missing target is reported as a usable error", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });
  await assert.rejects(() => b.act({ kind: "click" }), /needs a target/);
  await mgr.remove(b.id);
});

test("records the session to a video file", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });

  const videoPath = await b.startRecording(path.join(tmp, "session.webm"));
  assert.equal(b.recording, videoPath);

  // Something has to change on screen, or the screencast has no frame to encode.
  await b.act({ kind: "click", target: "button" });
  await b.act({ kind: "type", target: "input", text: "recorded" });
  await new Promise((r) => setTimeout(r, 1500));

  const result = await b.stopRecording();
  assert.ok(result, "stopRecording should return a result while recording");
  assert.equal(b.recording, null);
  assert.ok(statSync(videoPath).size > 0, "the video file should not be empty");
  assert.equal(await b.stopRecording(), null, "stopping twice should report nothing was recording");

  await mgr.remove(b.id);
});

test("mirrors frames to a viewer and takes human input", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });

  const frames: string[] = [];
  const stop = b.onFrame((data) => frames.push(data));
  await b.act({ kind: "click", target: "button" });
  await new Promise((r) => setTimeout(r, 1500));
  stop();
  assert.ok(frames.length > 0, "a viewer should receive at least one frame");
  assert.ok(frames[0].length > 100, "frames should be base64 JPEG data");

  // A human typing in the viewer reaches the same page the agent drives.
  await b.act({ kind: "click", target: "input" });
  await b.input({ type: "text", text: "human" });
  assert.equal((await b.waitPattern("hi human", 5000)).ok, true);

  await mgr.remove(b.id);
});

// The viewer sends a click as a fraction of the frame because the frame it draws is twice
// scaled away from the real viewport. Getting that basis wrong puts every human click in the
// wrong place, and it is invisible until someone tries to click something small.
test("a viewer's click lands where the human aimed, whatever the frame size", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const quadrants =
    "data:text/html," +
    encodeURIComponent(
      `<style>body{margin:0}button{position:absolute;width:480px;height:300px}
       #a{left:5px;top:5px}#b{left:495px;top:5px}#c{left:5px;top:325px}#d{left:495px;top:325px}
       h1{position:absolute;left:0;top:0;font-size:16px}</style>
       <button id=a onclick="h('top-left')">a</button>
       <button id=b onclick="h('top-right')">b</button>
       <button id=c onclick="h('bottom-left')">c</button>
       <button id=d onclick="h('bottom-right')">d</button>
       <h1 id=out>nothing</h1>
       <script>function h(t){document.getElementById('out').textContent=t}</script>`,
    );
  const b = await mgr.createBrowser({ headless: true, url: quadrants, width: 1000, height: 650 });

  for (const [x, y, expected] of [
    [0.25, 0.25, "top-left"],
    [0.75, 0.25, "top-right"],
    [0.25, 0.75, "bottom-left"],
    [0.75, 0.75, "bottom-right"],
  ] as const) {
    await b.input({ type: "click", x, y });
    const hit = await b.waitPattern(expected, 3000);
    assert.equal(hit.ok, true, `a click at (${x}, ${y}) of the frame should land on ${expected}`);
  }

  await mgr.remove(b.id);
});

test("a link that opens a tab takes the session with it, and tabs can be switched back", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  // Chrome refuses a top-level navigation to a data: URL, so the popup writes its own body.
  const opener =
    "data:text/html," +
    encodeURIComponent(
      `<h1>opener</h1>
       <button id=go onclick="window.open('about:blank').document.write('<h1>popup</h1>')">open a tab</button>`,
    );
  const b = await mgr.createBrowser({ headless: true, url: opener, width: 800, height: 600 });

  await b.act({ kind: "click", target: "#go" });
  await new Promise((r) => setTimeout(r, 1200));

  const onPopup = await b.snapshot();
  assert.match(onPopup, /heading "popup"/, "the new tab should be the one being driven");
  assert.match(onPopup, /tab 1 of 2/, "the snapshot should say which tab it is");

  const tabs = await b.tabList();
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].active, true, "the newest tab should be the active one");

  await b.selectTab(0);
  assert.match(await b.snapshot(), /heading "opener"/, "selecting tab 0 should go back to the opener");

  await b.closeTab(1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await b.tabList()).length, 1);

  await mgr.remove(b.id);
});

test("closing the driven tab falls back to another instead of wedging the session", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: "data:text/html,<h1>first</h1>", width: 800, height: 600 });
  await b.newTab("data:text/html,<h1>second</h1>");
  await new Promise((r) => setTimeout(r, 500));
  assert.match(await b.snapshot(), /heading "second"/);

  await b.closeTab(1);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(b.alive, true, "one tab closing should not end the session");
  assert.match(await b.snapshot(), /heading "first"/, "the session should fall back to the remaining tab");

  await mgr.remove(b.id);
});

test("a dialog is answered the way the action asked, and reported afterwards", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const page =
    "data:text/html," +
    encodeURIComponent(
      `<h1 id=out>none</h1>
       <button id=c onclick="document.getElementById('out').textContent = confirm('sure?') ? 'confirmed' : 'refused'">c</button>
       <button id=p onclick="document.getElementById('out').textContent = 'got ' + prompt('name?')">p</button>`,
    );
  const b = await mgr.createBrowser({ headless: true, url: page, width: 800, height: 600 });

  // A dialog blocks the page until answered, so an unanswered one would hang this call.
  await b.act({ kind: "click", target: "#c" });
  let snap = await b.snapshot();
  assert.match(snap, /heading "refused"/, "an unanswered dialog should be dismissed");
  assert.match(snap, /confirm "sure\?" was dismissed/, "the dialog should be reported in the snapshot");
  assert.doesNotMatch(await b.snapshot(), /was dismissed/, "a dialog should only be reported once");

  await b.act({ kind: "click", target: "#c", dialog: "accept" });
  assert.match(await b.snapshot(), /heading "confirmed"/, "dialog: accept should accept it");

  await b.act({ kind: "click", target: "#p", dialog: "accept", dialogText: "ada" });
  assert.match(await b.snapshot(), /heading "got ada"/, "dialogText should answer a prompt");

  await mgr.remove(b.id);
});

test("a file is uploaded, and a missing one is named", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const file = path.join(tmp, "upload-me.txt");
  writeFileSync(file, "hello from a file");
  const page =
    "data:text/html," +
    encodeURIComponent(
      `<input id=f type=file><h1 id=out>nothing</h1>
       <script>document.getElementById('f').onchange = e =>
         document.getElementById('out').textContent = 'picked ' + e.target.files[0].name</script>`,
    );
  const b = await mgr.createBrowser({ headless: true, url: page, width: 800, height: 600 });

  await b.act({ kind: "upload", target: "#f", files: [file] });
  assert.match(await b.snapshot(), /heading "picked upload-me.txt"/);

  await assert.rejects(() => b.act({ kind: "upload", target: "#f", files: ["/no/such/file.txt"] }), /no such file/);
  await assert.rejects(() => b.act({ kind: "upload", target: "#f" }), /needs `files`/);

  await mgr.remove(b.id);
});

test("a download is saved to disk and reported once", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const page =
    "data:text/html," +
    encodeURIComponent(`<a id=d download="notes.txt" href="data:text/plain,downloaded%20text">get it</a>`);
  const b = await mgr.createBrowser({ headless: true, url: page, width: 800, height: 600 });

  await b.act({ kind: "click", target: "#d" });
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(b.downloads.length, 1, "the download should have been saved");
  assert.match(b.downloads[0], /notes\.txt$/);
  assert.equal(readFileSync(b.downloads[0], "utf8"), "downloaded text");
  assert.match(await b.snapshot(), /downloaded .*notes\.txt/, "the snapshot should mention it");
  assert.doesNotMatch(await b.snapshot(), /downloaded /, "and mention it only once");

  rmSync(path.dirname(b.downloads[0]), { recursive: true, force: true });
  await mgr.remove(b.id);
});

test("a huge page is cut with a note, and depth or full bring the rest back", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  // 2000 list items is well past the cap, whatever exact value it has.
  const big = "data:text/html," + encodeURIComponent(`<ul>${"<li>row</li>".repeat(2000)}</ul>`);
  const b = await mgr.createBrowser({ headless: true, url: big, width: 800, height: 600 });

  const cut = await b.snapshot();
  assert.match(cut, /more not shown/, "an oversized snapshot should say it was cut");
  assert.ok(cut.length < 20_000, `a cut snapshot should be small, got ${cut.length} chars`);
  assert.ok(!cut.endsWith("- listitem"), "the cut should land on a line boundary");

  const full = await b.snapshot(undefined, true);
  assert.doesNotMatch(full, /more not shown/);
  assert.ok(full.length > 40_000, "full should return everything");

  await mgr.remove(b.id);
});

test("a recording that cannot start says so instead of handing back a phantom file", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, url: PAGE, width: 600, height: 400 });
  // A directory that cannot be created is the simplest way to make the screencast refuse.
  const impossible = path.join(tmp, "not-a-dir.txt", "video.webm");
  writeFileSync(path.join(tmp, "not-a-dir.txt"), "a file, not a folder");

  await assert.rejects(() => b.startRecording(impossible), /could not start recording/);
  assert.equal(b.recording, null, "a failed start should leave the session not recording");
  assert.equal(await b.stopRecording(), null, "and nothing to stop");

  // The session must still work afterwards, both for driving and for a real recording.
  const good = await b.startRecording(path.join(tmp, "after-failure.webm"));
  await b.act({ kind: "click", target: "button" });
  await new Promise((r) => setTimeout(r, 1200));
  const result = await b.stopRecording();
  assert.equal(result?.videoPath, good);
  assert.ok(statSync(good).size > 0);

  await mgr.remove(b.id);
});

test("the manager keeps the two kinds of session apart", async (t) => {
  if (!haveChrome) return t.skip("Chrome not installed");
  const b = await mgr.createBrowser({ headless: true, width: 600, height: 400 });
  const term = mgr.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });

  assert.throws(() => mgr.get(b.id), /browser session/);
  assert.throws(() => mgr.getBrowser(term.id), /terminal session/);
  assert.throws(() => mgr.any("web-999"), /No session/);
  assert.equal(mgr.list().length, 2);
  assert.equal(b.info().kind, "browser");
  assert.equal(term.info().kind, "terminal");

  await mgr.remove(b.id);
  await mgr.remove(term.id);
  assert.equal(mgr.list().length, 0);
});
