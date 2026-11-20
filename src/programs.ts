// What a project runs on the simulated brain: a plain .bin; a PROS hot/cold
// pair (the hot package linked to the cold package); or a VEXcode Python
// main.py linked to VEX's MicroPython VM. The simulator installs the linked
// ones as PROS and vexcom upload them (v5brain.sh --run FILE --link LIB).
// No VS Code imports: the tests run it under plain Node, with a fake Fs.
import * as path from 'node:path';

export type Program =
  | { kind: 'bin'; file: string; elf?: string }                // elf: its symbols, when beside it (Rust)
  | { kind: 'hotcold'; file: string; link: string }          // hot.package.bin, cold.package.bin
  | { kind: 'python'; file: string; link: string };          // main.py, python_vm.bin

export interface Fs {
  exists(p: string): boolean;
  mtime(p: string): number;
  read(p: string): string | undefined;
  list(dir: string): string[];
}

export interface Project {
  /** shown in pickers and messages */
  label: string;
  /** the project's own slot (VEXcode keeps one), if any */
  slot?: number;
  program?: Program;
  /** why it can't run, when program is undefined */
  problem?: string;
}

/** A PROS project (project.pros in root): its hot/cold pair when both exist
 *  and are newer than the monolith (pros upload's rule), else its monolith. */
export function prosProject(root: string, fs: Fs): Project | undefined {
  const text = fs.read(path.join(root, 'project.pros'));
  if (text === undefined) return undefined;
  const meta = kernelMetadata(text);
  const name = path.basename(root);
  const at = (rel: string | undefined, fallback: string) => path.join(root, rel ?? fallback);
  const mono = at(meta.output, 'bin/monolith.bin');
  const hot = at(meta.hot_output, 'bin/hot.package.bin');
  const cold = at(meta.cold_output, 'bin/cold.package.bin');
  if (fs.exists(hot) && fs.exists(cold) && (!fs.exists(mono) || fs.mtime(hot) > fs.mtime(mono))) {
    return { label: `PROS project ${name} (hot/cold)`, program: { kind: 'hotcold', file: hot, link: cold } };
  }
  if (fs.exists(mono)) return { label: `PROS project ${name}`, program: { kind: 'bin', file: mono } };
  return { label: `PROS project ${name}`, problem: 'it has no build yet: build it first (pros make)' };
}

/** project.pros is jsonpickle: the kernel template's metadata, wherever it sits. */
function kernelMetadata(text: string): Record<string, string | undefined> {
  try {
    const root = JSON.parse(text);
    const state = root['py/state'] ?? root;
    const kernel = state?.templates?.kernel;
    const meta = (kernel?.['py/state'] ?? kernel)?.metadata;
    return meta && typeof meta === 'object' ? meta : {};
  } catch {
    return {};
  }
}

interface VexSettings {
  project?: {
    name?: string; slot?: number; platform?: string; language?: string; sdkVersion?: string;
    python?: { main?: string };
  };
}

/** A VEXcode project (.vscode/vex_project_settings.json in root): C++ runs
 *  its newest build/*.bin; Python its main.py with VEX's VM from the VEXcode
 *  extension's SDK (sdkRoot: .../vexrobotics.vexcode/sdk/python). */
export function vexProject(root: string, fs: Fs, sdkRoot: string | undefined): Project | undefined {
  const text = fs.read(path.join(root, '.vscode', 'vex_project_settings.json'));
  if (text === undefined) return undefined;
  let settings: VexSettings;
  try { settings = JSON.parse(text); } catch { return undefined; }
  const p = settings.project ?? {};
  const name = p.name || path.basename(root);
  const slot = Number.isInteger(p.slot) && p.slot! >= 1 && p.slot! <= 8 ? p.slot : undefined;
  if ((p.platform ?? 'V5') !== 'V5') return { label: `VEXcode project ${name}`, slot, problem: `it's a ${p.platform} project, not V5` };
  if (p.language === 'python') {
    const label = `VEXcode Python project ${name}`;
    const main = path.join(root, p.python?.main || path.join('src', 'main.py'));
    if (!fs.exists(main)) return { label, slot, problem: `there's no ${path.relative(root, main)}` };
    const vm = sdkRoot ? pythonVm(sdkRoot, p.sdkVersion, fs) : undefined;
    if (!vm) {
      return { label, slot, problem: "VEX's Python runtime isn't installed: open the project with the VEXcode extension once (it downloads the SDK)" };
    }
    return { label, slot, program: { kind: 'python', file: main, link: vm } };
  }
  const label = `VEXcode project ${name}`;
  const build = path.join(root, 'build');
  const bins = fs.list(build).filter(f => /\.bin$/i.test(f)).map(f => path.join(build, f))
    .sort((a, b) => fs.mtime(b) - fs.mtime(a));
  if (!bins.length) return { label, slot, problem: 'it has no build yet: build it first' };
  return { label, slot, program: { kind: 'bin', file: bins[0] } };
}

/** What this extension needs from a Cargo.toml. */
export interface CargoManifest {
  name?: string;
  /** [package.metadata.v5] slot, when 1-8 */
  slot?: number;
  /** has a [package.metadata.v5] section (cargo-v5's settings) */
  v5Metadata: boolean;
  /** crate names in [dependencies] and [workspace.dependencies] */
  dependencies: Set<string>;
  workspace: boolean;
  /** name.workspace = true: the name is the workspace's */
  nameFromWorkspace?: boolean;
}

/** A small TOML reader for the keys above: [sections], key = value lines,
 *  # comments. Not a TOML parser (no multi-line values, no inline tables
 *  beyond reading a dependency's name). */
export function readCargo(text: string): CargoManifest {
  const out: CargoManifest = { v5Metadata: false, dependencies: new Set(), workspace: false };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const header = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/.exec(line);
    if (header) {
      section = line.startsWith('[[') ? '' : header[1];
      if (section === 'package.metadata.v5') out.v5Metadata = true;
      if (section === 'workspace') out.workspace = true;
      const dep = /^(?:workspace\.)?dependencies\.(.+)$/.exec(section);
      if (dep) out.dependencies.add(unquote(dep[1]));
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    // the key from [package] down, so [package.metadata] v5.slot = 2 and
    // [package] metadata.v5.slot = 2 read like [package.metadata.v5] slot = 2
    const key = (section ? `${section}.` : '') + unquote(kv[1]);
    const value = kv[2];
    if (key === 'package.name') out.name = unquote(value);
    else if (key === 'package.name.workspace') out.nameFromWorkspace = true;
    else if (key === 'package.metadata.v5.slot') out.slot = slotOf(value);
    else if (key === 'package.metadata.v5') {                    // v5 = { slot = 2, ... }
      out.v5Metadata = true;
      const slot = /\bslot\s*=\s*(\d+)/.exec(value);
      if (slot) out.slot = slotOf(slot[1]);
    } else if (key.startsWith('package.metadata.v5.')) {
      out.v5Metadata = true;
    }
    const dep = /^(?:workspace\.)?dependencies\.([^.]+)/.exec(key);
    if (dep) out.dependencies.add(dep[1]);
  }
  return out;
}

function slotOf(value: string): number | undefined {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : undefined;
}

function stripTomlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function unquote(v: string): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(v);
  return m ? (m[1] ?? m[2]) : v.trim();
}

/** cargo-v5 builds for thumbv7a-vex-v5 unless the project picks
 *  armv7a-vex-v5 (v5gdb's docs do). */
const RUST_TRIPLES = ['thumbv7a-vex-v5', 'armv7a-vex-v5'];
const RUST_PROFILES = ['debug', 'release'];

const isVexideManifest = (c: CargoManifest) => c.dependencies.has('vexide') || c.v5Metadata;

/** A Cargo.toml's text is a vexide project's (or workspace's). */
export const isVexideCargo = (text: string) => isVexideManifest(readCargo(text));

/** A vexide (Rust) project (a Cargo.toml using vexide, or with cargo-v5's
 *  [package.metadata.v5]): its newest build, target/<triple>/<profile>/<name>.bin
 *  (cargo-v5 writes it beside the ELF, which keeps the name without .bin). */
export function cargoProject(root: string, fs: Fs): Project | undefined {
  const text = fs.read(path.join(root, 'Cargo.toml'));
  if (text === undefined) return undefined;
  const c = readCargo(text);
  if (!isVexideManifest(c)) return undefined;
  if (!c.name && c.workspace) {
    return { label: `Rust workspace ${path.basename(root)}`,
      problem: "it's a Cargo workspace: open the robot's own folder (the one whose Cargo.toml has a [package])" };
  }
  const label = `Rust project ${c.name ?? path.basename(root)}`;
  // name.workspace = true: the name isn't here, so take whatever .bin is built
  const named = (f: string) => !c.name || [c.name, c.name.replace(/-/g, '_')].includes(f.slice(0, -'.bin'.length));
  const bins = RUST_TRIPLES.flatMap(t => RUST_PROFILES.flatMap(p => {
    const dir = path.join(root, 'target', t, p);
    return fs.list(dir).filter(f => /\.bin$/i.test(f) && !/^slot_\d+\.base\.bin$/i.test(f) && named(f)).map(f => path.join(dir, f));
  })).sort((a, b) => fs.mtime(b) - fs.mtime(a));
  if (!bins.length) {
    return { label, slot: c.slot, problem: "it has no build in its target/ folder yet: build it first (cargo v5 build). " +
      "A workspace member or a custom target-dir isn't supported yet" };
  }
  const file = bins[0];
  const elf = file.slice(0, -'.bin'.length);
  return { label, slot: c.slot, program: fs.exists(elf) ? { kind: 'bin', file, elf } : { kind: 'bin', file } };
}

const C_SOURCE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inc|s)$/i;
const RUST_SOURCE = /\.rs$/i;
const MAX_SOURCE_ENTRIES = 20_000;
const MAX_SOURCE_DEPTH = 10;

/** The newest source file changed after the program was built, if any:
 *  C/C++ files in src/ and include/ (PROS, VEXcode), or .rs files in src/
 *  plus build.rs and Cargo.lock (Rust). Only files a build turns into a new
 *  program count (not Cargo.toml: a comment there doesn't rebuild). A
 *  Python program is its own source: never stale. */
export function staleSource(root: string, program: Program, fs: Fs): string | undefined {
  if (program.kind === 'python') return undefined;
  const built = fs.mtime(program.file);
  const cargo = fs.read(path.join(root, 'Cargo.toml'));
  const rust = cargo !== undefined && isVexideCargo(cargo);
  const dirs = rust ? ['src'] : ['src', 'include'];
  const isSource = (name: string) => (rust ? RUST_SOURCE : C_SOURCE).test(name);
  let newest: { file: string; mtime: number } | undefined;
  const consider = (file: string) => {
    const m = fs.mtime(file);
    if (m > built && (!newest || m > newest.mtime)) newest = { file, mtime: m };
  };
  let seen = 0;
  const visit = (dir: string, depth: number): void => {
    for (const c of fs.list(dir)) {
      if (++seen > MAX_SOURCE_ENTRIES) return;
      if (c.startsWith('.') || c === 'node_modules') continue;   // hidden files, editor/VCS folders
      const p = path.join(dir, c);
      if (isSource(c)) consider(p);
      else if (depth < MAX_SOURCE_DEPTH) visit(p, depth + 1);    // a file's list is empty
    }
  };
  for (const d of dirs) visit(path.join(root, d), 0);
  if (rust) for (const f of ['build.rs', 'Cargo.lock']) if (fs.exists(path.join(root, f))) consider(path.join(root, f));
  return newest?.file;
}

/** How to build a project: a shell command in its folder, or a VS Code
 *  command (VEXcode's extension builds VEXcode projects). */
export type BuildStep = { shell: string } | { command: string };

export function buildFor(root: string, program: Program, fs: Fs): BuildStep | undefined {
  if (fs.exists(path.join(root, 'project.pros'))) return { shell: 'pros make' };
  if (fs.exists(path.join(root, '.vscode', 'vex_project_settings.json'))) return { command: 'vexrobotics.vexcode.project.build' };
  const cargo = fs.read(path.join(root, 'Cargo.toml'));
  if (cargo !== undefined && isVexideCargo(cargo)) {
    // the same profile as the build it replaces
    return { shell: path.basename(path.dirname(program.file)) === 'release' ? 'cargo v5 build --release' : 'cargo v5 build' };
  }
  return undefined;
}

/** VEX's V5 MicroPython VM: the project's SDK version, else the newest. */
export function pythonVm(sdkRoot: string, sdkVersion: string | undefined, fs: Fs): string | undefined {
  const v5 = path.join(sdkRoot, 'V5');
  const vmIn = (dir: string) => path.join(v5, dir, 'vexv5', 'vm', 'python_vm.bin');
  if (sdkVersion && fs.exists(vmIn(sdkVersion))) return vmIn(sdkVersion);
  const dirs = fs.list(v5).filter(d => /^V5_[\d_]+$/.test(d) && fs.exists(vmIn(d)));
  dirs.sort((a, b) => compareVersions(b, a));
  return dirs.length ? vmIn(dirs[0]) : undefined;
}

/** V5_1_0_1_25 vs V5_1_0_1_9: by number, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('_').slice(1).map(Number), pb = b.split('_').slice(1).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The project a file belongs to: the folder holding project.pros,
 *  .vscode/vex_project_settings.json or a vexide Cargo.toml, at or above
 *  the file (up to 3 up). */
export function projectRoot(file: string, fs: Fs): string | undefined {
  let dir = path.dirname(file);
  for (let i = 0; i < 4; i++) {
    if (fs.exists(path.join(dir, 'project.pros')) || fs.exists(path.join(dir, '.vscode', 'vex_project_settings.json'))) {
      return dir;
    }
    const cargo = fs.read(path.join(dir, 'Cargo.toml'));
    if (cargo !== undefined && isVexideManifest(readCargo(cargo))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** The project at root: PROS, VEXcode or vexide (Rust). */
export function project(root: string, fs: Fs, sdkRoot: string | undefined): Project | undefined {
  return prosProject(root, fs) ?? vexProject(root, fs, sdkRoot) ?? cargoProject(root, fs);
}

/** A one-word description for messages. */
export function describe(p: Program): string {
  const base = path.basename(p.file);
  return p.kind === 'hotcold' ? `${base} + ${path.basename(p.link)}` : base;
}

export interface FileProgram { program?: Program; slot?: number; problem?: string }

/** What a file chosen by the user runs as (the explorer's Run Program on
 *  Sim, the file picker): its project's program when it is part of it (a
 *  hot/cold half, the project's main.py), a .bin or a VEXcode Python .py as
 *  itself, anything else not at all (a .cpp is source, not a program).
 *  pythonVmFile: VEX's MicroPython VM, if installed. */
export function programForFile(file: string, proj: Project | undefined, pythonVmFile: string | undefined): FileProgram {
  const base = path.basename(file).toLowerCase();
  const p = proj?.program;
  if (p && (p.file === file || ('link' in p && p.link === file))) return { program: p, slot: proj!.slot };
  if (base === 'hot.package.bin' || base === 'cold.package.bin') {
    return { problem: `${path.basename(file)} is half of a PROS hot/cold program: run its project's build` };
  }
  if (/^slot_\d+\.base\.bin$/.test(base)) {
    return { problem: `${path.basename(file)} is the base of a cargo-v5 differential upload, not a program: run its project's build` };
  }
  if (base.endsWith('.py')) {
    return pythonVmFile ? { program: { kind: 'python', file, link: pythonVmFile }, slot: proj?.slot }
      : { problem: "VEX's Python runtime isn't installed: open a V5 Python project with the VEXcode extension once" };
  }
  if (base.endsWith('.bin')) return { program: { kind: 'bin', file }, slot: proj?.slot };
  return { problem: `${path.basename(file)} isn't a V5 program (a .bin, or a VEXcode Python .py)` };
}

/** What the editor's Run on Sim button runs for the open file: its
 *  project's program (whatever file of the project is open), or nothing,
 *  so the caller can ask. */
export function programForEditor(proj: Project | undefined): FileProgram | undefined {
  if (!proj) return undefined;
  return proj.program ? { program: proj.program, slot: proj.slot } : { problem: proj.problem };
}
