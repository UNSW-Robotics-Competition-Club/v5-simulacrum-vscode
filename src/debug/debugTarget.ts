// What Debug on Sim needs from a project: the ELF files GDB reads symbols
// from, whether the program has v5gdb in it (the debugger that runs inside
// a vexide or PROS program and talks to GDB over the user port), and
// whether its framework is new enough for v5gdb. Also the debug
// configuration handed to VS Code. No VS Code imports: tested under Node.
import * as path from 'node:path';

import { Fs, Program, readCargo } from '../programs';

/** v5gdb's minimum framework versions (its setup pages). */
export const MIN_VEXIDE = '0.9.0-alpha.1';
export const MIN_PROS_KERNEL = '4.2.3';
/** v5gdb's memory map for GDB, and its cache line (its VS Code recipe). */
export const V5GDB_SETUP = ['mem 0x100000 0x2c00000 ro cache', 'mem 0x2c00000 0x8000000 rw cache', 'set dcache line-size 1024'];

export interface DebugTarget {
  framework: 'vexide' | 'pros';
  /** the ELF GDB debugs; more symbol files (a PROS cold package) after it */
  elf: string;
  moreElfs: string[];
  usesV5gdb: boolean;
  /** the framework's version (vexide from Cargo.lock, the PROS kernel), if known */
  version?: string;
  /** older than v5gdb supports */
  tooOld: boolean;
}

export type DebugTargetResult = { target: DebugTarget } | { problem: string };

export function debugTarget(root: string, program: Program, fs: Fs): DebugTargetResult {
  const pros = fs.read(path.join(root, 'project.pros'));
  if (pros !== undefined) return prosTarget(pros, program, fs);
  const cargo = fs.read(path.join(root, 'Cargo.toml'));
  if (cargo !== undefined) return rustTarget(root, cargo, program, fs);
  return { problem: 'debugging needs v5gdb, which works in PROS and vexide (Rust) projects, not VEXcode ones' };
}

function prosTarget(text: string, program: Program, fs: Fs): DebugTargetResult {
  const templates = prosTemplates(text);
  const elfOf = (bin: string) => bin.replace(/\.bin$/i, '.elf');
  const elfs = program.kind === 'hotcold' ? [elfOf(program.file), elfOf(program.link)] : [elfOf(program.file)];
  const missing = elfs.find(e => !fs.exists(e));
  if (missing) return { problem: `there's no ${path.basename(missing)} beside the build: build the project again (pros make)` };
  const version = templates.kernel?.version;
  return { target: { framework: 'pros', elf: elfs[0], moreElfs: elfs.slice(1), usesV5gdb: 'v5gdb' in templates,
    version, tooOld: version !== undefined && compareSemver(version, MIN_PROS_KERNEL) < 0 } };
}

/** project.pros (jsonpickle): its templates by name, with their versions. */
export function prosTemplates(text: string): Record<string, { version?: string }> {
  try {
    const root = JSON.parse(text);
    const templates = (root['py/state'] ?? root)?.templates ?? {};
    const out: Record<string, { version?: string }> = {};
    for (const [name, t] of Object.entries<any>(templates)) {
      const v = t?.version ?? t?.['py/state']?.version;
      out[name] = { version: typeof v === 'string' ? v : undefined };
    }
    return out;
  } catch {
    return {};
  }
}

function rustTarget(root: string, cargoText: string, program: Program, fs: Fs): DebugTargetResult {
  const c = readCargo(cargoText);
  if (program.kind !== 'bin' || !program.elf || !fs.exists(program.elf)) {
    return { problem: `there's no ELF beside ${path.basename(program.file)}: build the project again (cargo v5 build)` };
  }
  const version = lockedVersion(fs.read(path.join(root, 'Cargo.lock')), 'vexide');
  return { target: { framework: 'vexide', elf: program.elf, moreElfs: [], usesV5gdb: c.dependencies.has('v5gdb'),
    version, tooOld: version !== undefined && compareSemver(version, MIN_VEXIDE) < 0 } };
}

/** A package's version in a Cargo.lock ([[package]] name = ..., version = ...). */
export function lockedVersion(lock: string | undefined, name: string): string | undefined {
  if (!lock) return undefined;
  for (const block of lock.split(/\r?\n\s*\[\[package\]\]\s*\r?\n/)) {
    if (new RegExp(`^name = "${name}"\\s*$`, 'm').test(block)) {
      return /^version = "([^"]+)"/m.exec(block)?.[1];
    }
  }
  return undefined;
}

/** Semantic versions: 0.9.0-alpha.1 < 0.9.0 < 0.10.0. */
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/, '').split('+')[0].split(/-(.*)/s);
    return { main: main.split('.').map(n => Number(n) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d) return d;
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;   // a release is newer
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    const d = np && nq ? Number(p) - Number(q) : np ? -1 : nq ? 1 : p.localeCompare(q);
    if (d) return d;
  }
  return 0;
}

/** The debugger extension that runs GDB for us. */
export type Debugger = 'cppdbg' | 'native-debug';

/** The debug configuration: GDB (on this machine) loads the ELFs and
 *  connects to the simulator's v5gdb bridge, as v5gdb's VS Code recipe. */
export function debugConfiguration(t: DebugTarget, o: { name: string; gdb: string; port: number; cwd: string; via: Debugger }):
  Record<string, unknown> {
  // a slow (emulated) brain: GDB waits longer than its 2 s for each reply
  const symbols = ['set remotetimeout 10', ...t.moreElfs.map(e => `add-symbol-file ${gdbPath(e)}`)];
  const server = `127.0.0.1:${o.port}`;
  if (o.via === 'native-debug') {
    return { type: 'gdb', request: 'attach', name: o.name, executable: t.elf, target: server, remote: true,
      cwd: o.cwd, gdbpath: o.gdb, autorun: [...V5GDB_SETUP, ...symbols], stopAtConnect: true };
  }
  return { type: 'cppdbg', request: 'launch', name: o.name, program: t.elf, cwd: o.cwd, MIMode: 'gdb',
    miDebuggerPath: o.gdb, miDebuggerServerAddress: server, stopAtConnect: true, externalConsole: false,
    setupCommands: [...V5GDB_SETUP, ...symbols].map(text => ({ text, ignoreFailures: false })) };
}

/** A path in a GDB command: forward slashes, quoted when it has spaces. */
function gdbPath(p: string): string {
  const s = p.replace(/\\/g, '/');
  return /\s/.test(s) ? `"${s}"` : s;
}

/** Where to look for GDB, in order: the setting, the PROS toolchain the
 *  PROS extension installs (it has arm-none-eabi-gdb), then PATH. */
export function gdbCandidates(platform: NodeJS.Platform, globalStorageParent: string, setting: string | undefined): string[] {
  const exe = platform === 'win32' ? '.exe' : '';
  const toolchain = platform === 'win32' ? 'pros-toolchain-windows' : platform === 'darwin' ? 'pros-toolchain-macos' : 'pros-toolchain-linux';
  const out = setting?.trim() ? [setting.trim()] : [];
  out.push(path.join(globalStorageParent, 'sigbots.pros', 'install', toolchain, 'usr', 'bin', `arm-none-eabi-gdb${exe}`));
  out.push(path.join(globalStorageParent, 'sigbots.pros', 'install', toolchain, 'bin', `arm-none-eabi-gdb${exe}`));
  out.push(`arm-none-eabi-gdb${exe}`, `gdb-multiarch${exe}`, `gdb${exe}`);
  return out;
}

/** The install line v5gdb's setup pages give for GDB, per OS. */
export function gdbInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'brew install gdb';
  if (platform === 'win32') return "install the PROS extension (its toolchain has GDB), or msys2's mingw-w64-ucrt-x86_64-gdb";
  return 'sudo apt install gdb-multiarch';
}
