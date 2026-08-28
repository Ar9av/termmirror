import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * npm does not preserve the executable bit on node-pty's `spawn-helper`, and without it
 * every spawn fails with "posix_spawnp failed". A postinstall script can restore it, but
 * install scripts are opt-in from npm v12 on and are skipped entirely by --ignore-scripts,
 * so the package cannot depend on one having run. Check and repair at spawn time instead.
 *
 * Runs on every spawn rather than caching: a few stat calls are free next to forking a
 * process, and caching would miss a helper whose permissions change after the first check.
 */
export function ensurePtyExecutable(): void {
  try {
    const require = createRequire(import.meta.url);
    const root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
    const candidates: string[] = [path.join(root, "build", "Release", "spawn-helper")];

    const prebuilds = path.join(root, "prebuilds");
    if (existsSync(prebuilds)) {
      for (const platform of readdirSync(prebuilds)) {
        candidates.push(path.join(prebuilds, platform, "spawn-helper"));
      }
    }

    for (const helper of candidates) {
      if (!existsSync(helper)) continue;
      const mode = statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
    }
  } catch {
    // Read-only install, unresolvable node-pty, or a platform without the helper.
    // The spawn error explains the problem if this turns out to have mattered.
  }
}
