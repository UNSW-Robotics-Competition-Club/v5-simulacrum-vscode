// The pure parts of runtime.ts (no VS Code): which simulator to use, the
// script that unpacks the bundled one, and its environment. Tested under Node
// and used by bundle/ext-smoke.js in CI.
import { sh } from './runner';

export type Mode =
  | { kind: 'repo'; repo: string }
  | { kind: 'bundled'; tarball: string }
  | { kind: 'none' };

/** Repo mode wins when a checkout is configured or found; else the bundle. */
export function chooseMode(found: string | undefined, tarball: string | undefined): Mode {
  if (found) return { kind: 'repo', repo: found };
  if (tarball) return { kind: 'bundled', tarball };
  return { kind: 'none' };
}

/** The data folder, in the simulator's Linux/macOS. No spaces: the
 *  simulator's scripts split some paths on them. */
export const DATA_DIR = '$HOME/.v5-simulacrum';

/** Unpack the runtime (once per extension version) and print where it is.
 *  Other versions' runtimes are removed unless a simulator is running from
 *  one (another editor, e.g. Cursor next to VS Code, may be on another
 *  version); firmware and runs are kept. Each unpack has a folder of its
 *  own, so two first starts at once don't mix their files. */
export function installScript(tarballUnix: string, version: string, force = false): string {
  const v = version.replace(/[^\w.-]/g, '_');
  return [
    'set -e',
    `D=${DATA_DIR}`,
    `R="$D/runtime-${v}"`,
    force ? 'rm -f "$R/.installed"' : '',
    'mkdir -p "$D"',
    'if [ ! -f "$R/.installed" ]; then',
    '  U=$(mktemp -d "$D/unpack.XXXXXX")',
    `  tar -xzf ${sh(tarballUnix)} -C "$U"`,
    '  rm -rf "$R"',
    '  mv "$U/runtime" "$R"',
    '  rm -rf "$U"',
    '  touch "$R/.installed"',
    'fi',
    // a process running from it (QEMU, Python, the scripts) names its path;
    // awk takes the path from the environment so it doesn't match itself
    `in_use() { ps -A -o args= 2>/dev/null | P="$1/" awk 'index($0, ENVIRON["P"]) { f = 1 } END { exit !f }'; }`,
    'for old in "$D"/runtime-*; do',
    '  [ -e "$old" ] && [ "$old" != "$R" ] || continue',
    '  in_use "$old" || rm -rf "$old"',
    'done',
    // unpacks left by an editor that quit mid-way (one running now is newer)
    'find "$D" -maxdepth 1 -name "unpack.*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true',
    'mkdir -p "$D/runs" "$D/firmware"',
    'echo "RUNTIME=$R"',
    'echo "DATA=$D"',
  ].filter(Boolean).join('\n');
}

export interface BundledPaths { runtime: string; data: string }

export function parseInstallOutput(out: string): BundledPaths | undefined {
  const runtime = /^RUNTIME=(.+)$/m.exec(out)?.[1];
  const data = /^DATA=(.+)$/m.exec(out)?.[1];
  return runtime && data ? { runtime: runtime.trim(), data: data.trim() } : undefined;
}

/** The environment the simulator's scripts get in bundled mode. */
export function bundledEnv(p: BundledPaths): { env: Record<string, string>; pathPrefix: string } {
  return {
    env: {
      V5SIM_QEMU: `${p.runtime}/qemu/bin/qemu-system-arm`,
      V5SIM_PYTHON: `${p.runtime}/python/bin/python3`,
      V5SIM_RUNS: `${p.data}/runs`,
      V5SIM_FIRMWARE_DIR: `${p.data}/firmware`,
    },
    pathPrefix: `${p.runtime}/python/bin`,
  };
}

/** `wsl.exe -l -q` prints UTF-16 with NULs; the distro names. */
export function parseWslList(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf16le');
  return text.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

