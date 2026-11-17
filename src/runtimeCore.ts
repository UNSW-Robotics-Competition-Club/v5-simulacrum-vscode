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
 *  Old versions' runtimes are removed; firmware and runs are kept. */
export function installScript(tarballUnix: string, version: string, force = false): string {
  const v = version.replace(/[^\w.-]/g, '_');
  return [
    'set -e',
    `D=${DATA_DIR}`,
    `R="$D/runtime-${v}"`,
    force ? 'rm -f "$R/.installed"' : '',
    'if [ ! -f "$R/.installed" ]; then',
    '  rm -rf "$R" "$D/unpack"',
    '  mkdir -p "$D/unpack"',
    `  tar -xzf ${sh(tarballUnix)} -C "$D/unpack"`,
    '  mv "$D/unpack/runtime" "$R"',
    '  rm -rf "$D/unpack"',
    '  touch "$R/.installed"',
    'fi',
    'for old in "$D"/runtime-*; do [ "$old" = "$R" ] || rm -rf "$old"; done',
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

