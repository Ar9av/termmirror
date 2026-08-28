#!/usr/bin/env node
// npm does not preserve the executable bit on node-pty's `spawn-helper`, and without it
// every pty spawn dies with "posix_spawnp failed". Resolve node-pty wherever npm actually
// put it — hoisted to the consumer's root in a normal install, nested here in a dev
// checkout — and restore the bit.
import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const EXECUTABLE = 0o755;

function fix(file) {
  if (existsSync(file)) chmodSync(file, EXECUTABLE);
}

try {
  const require = createRequire(import.meta.url);
  const root = path.resolve(path.dirname(require.resolve("node-pty")), "..");

  const prebuilds = path.join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) fix(path.join(prebuilds, platform, "spawn-helper"));
  }
  fix(path.join(root, "build", "Release", "spawn-helper"));
} catch {
  // node-pty is not resolvable yet; the runtime error message covers this case.
}
