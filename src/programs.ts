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
    const key = unquote(kv[1]);
    if (section === 'package' && key === 'name') out.name = unquote(kv[2]);
    else if (section === 'package.metadata.v5' && key === 'slot') {
      const n = Number(kv[2]);
      if (Number.isInteger(n) && n >= 1 && n <= 8) out.slot = n;
    } else if (section === 'dependencies' || section === 'workspace.dependencies') {
      out.dependencies.add(key.split('.')[0]);
    }
  }
  return out;
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
  if (!c.name) {
    return { label: `Rust workspace ${path.basename(root)}`,
      problem: "it's a Cargo workspace: open the robot's own folder (the one whose Cargo.toml has a [package])" };
  }
  const label = `Rust project ${c.name}`;
  const names = [...new Set([c.name, c.name.replace(/-/g, '_')])];
  const bins = RUST_TRIPLES.flatMap(t => RUST_PROFILES.flatMap(p => names.map(n => path.join(root, 'target', t, p, `${n}.bin`))))
    .filter(f => fs.exists(f))
    .sort((a, b) => fs.mtime(b) - fs.mtime(a));
  if (!bins.length) return { label, slot: c.slot, problem: 'it has no build yet: build it first (cargo v5 build)' };
  const file = bins[0];
  const elf = file.slice(0, -'.bin'.length);
  return { label, slot: c.slot, program: fs.exists(elf) ? { kind: 'bin', file, elf } : { kind: 'bin', file } };
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
