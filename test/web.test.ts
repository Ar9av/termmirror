import assert from "node:assert/strict";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { SessionManager } from "../src/session.js";
import { startWebUI } from "../src/web.js";

const manager = new SessionManager();
const web = await startWebUI(manager, 0);
after(async () => {
  await manager.killAll();
  await web.close();
});

function connect(id: string) {
  const ws = new WebSocket(`${web.url.replace("http", "ws")}/?session=${id}`);
  const output: string[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "output") output.push(msg.data);
  });
  return { ws, output, ready: new Promise((r) => ws.once("open", r)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a viewer sees live output and can type into the session", async () => {
  const s = manager.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  const viewer = connect(s.id);
  await viewer.ready;

  viewer.ws.send(JSON.stringify({ type: "input", data: "echo from-the-browser\r" }));
  await s.waitIdle(300, 5000);
  assert.match(viewer.output.join(""), /from-the-browser/);

  // A second viewer must see what the first one did, from the replay buffer.
  const observer = connect(s.id);
  await observer.ready;
  await sleep(200);
  assert.match(observer.output.join(""), /from-the-browser/);

  viewer.ws.close();
  observer.ws.close();
  await manager.remove(s.id);
});

test("query replies from a watching browser are not forwarded twice", async () => {
  const s = manager.create({ command: "/bin/bash", args: ["--norc", "--noprofile"] });
  await s.waitIdle(300, 5000);
  const viewer = connect(s.id);
  await viewer.ready;

  s.write("stty -echo; cat\r");
  await s.waitIdle(300, 5000);
  viewer.output.length = 0;

  // What a browser terminal sends back on its own: a device-attributes reply and a
  // cursor-position report. Neither should reach the program.
  viewer.ws.send(JSON.stringify({ type: "input", data: "\x1b[?1;2c" }));
  viewer.ws.send(JSON.stringify({ type: "input", data: "\x1b[24;80R" }));
  // A pasted line looks similar but is real input and must still go through.
  viewer.ws.send(JSON.stringify({ type: "input", data: "typed-anyway\r" }));
  await sleep(1200);

  const seen = viewer.output.join("");
  assert.doesNotMatch(seen, /1;2c|24;80R/, "terminal replies must be dropped");
  assert.match(seen, /typed-anyway/, "real typing must still reach the program");

  viewer.ws.close();
  await manager.remove(s.id);
});
