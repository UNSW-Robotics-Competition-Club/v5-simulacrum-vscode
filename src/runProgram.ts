// Getting a program onto the simulated brain where VEXcode's Download button
// can't see it (macOS, or WSL without usbip-win2): (re)start the sim with
// --run, which installs it in a slot and starts it. A project runs what
// its own tools would download (programs.ts): a .bin; a PROS hot/cold pair;
// a VEXcode Python main.py with VEX's VM. A PROS project can also go through
// `pros upload` to the sim's serial port, in a terminal.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { FileProgram, Fs, Program, Project, describe, isVexideCargo, programForEditor, programForFile, project, projectRoot, pythonVm } from './programs';
import { isWindows, onPath, sh, terminalEnv } from './runner';
import { installUsbDriver } from './usbDriver';
import { upToDate } from './buildFirst';
import { runOnRunning } from './liveUpload';
import { slotSetting } from './settings';
import { Running, SimInstance } from './simInstance';

type Pick = vscode.QuickPickItem & { action: 'program' | 'pros' | 'cargo' | 'browse'; program?: Program; slot?: number };

/** The disk, for programs.ts. */
export const diskFs: Fs = {
  exists: p => fs.existsSync(p),
  mtime: p => mtime(p),
  read: p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
  list: d => { try { return fs.readdirSync(d); } catch { return []; } },
};

/** The VEXcode extension's Python SDK (VEX's VM is in it), next to ours. */
let vexSdk: string | undefined;
let runLog: vscode.OutputChannel | undefined;
export function initPrograms(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  vexSdk = path.join(path.dirname(context.globalStorageUri.fsPath), 'vexrobotics.vexcode', 'sdk', 'python');
  runLog = log;
}
export const vexSdkRoot = () => vexSdk;

/** The project a file belongs to, if any. */
export function projectOf(file: string): Project | undefined {
  const root = projectRoot(file, diskFs);
  return root ? project(root, diskFs, vexSdk) : undefined;
}

/** What a given file runs as: its project's program when the file is part of
 *  it (a hot/cold half, main.py), else the file itself. */
export function programFor(file: string): FileProgram {
  const vm = /\.py$/i.test(file) && vexSdk ? pythonVm(vexSdk, undefined, diskFs) : undefined;
  return programForFile(file, projectOf(file), vm);
}

/** The editor title bar's Run on Sim: VS Code passes the open file (often
 *  a .cpp), so run that file's project, not the file; outside a project,
 *  ask as the command palette does. */
export async function runEditorProgram(sim: SimInstance, file?: string): Promise<void> {
  const target = file ? programForEditor(projectOf(file)) : undefined;
  if (!target) return runProgram(sim);
  if (!target.program) {
    void vscode.window.showWarningMessage(`Can't run this project on the simulator: ${target.problem}.`);
    return;
  }
  const s = await pickSlot(target.slot);
  if (s) await runOn(sim, target.program, s);
}

export async function runProgram(sim: SimInstance, given?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (given) {                         // from the explorer
    const { program, slot, problem } = programFor(given);
    if (!program) { void vscode.window.showWarningMessage(`Can't run ${path.basename(given)} on the simulator: ${problem}.`); return; }
    const s = await pickSlot(slot);
    if (s) await runOn(sim, program, s);
    return;
  }
  const picks: Pick[] = [];
  // each workspace folder that is a PROS or VEXcode project: what it builds
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const proj = project(f.uri.fsPath, diskFs, vexSdk);
    if (!proj) continue;
    picks.push(proj.program
      ? { label: `$(play) ${proj.label}`, description: describe(proj.program), action: 'program', program: proj.program, slot: proj.slot,
          detail: proj.slot ? `slot ${proj.slot}` : undefined }
      : { label: `$(warning) ${proj.label}`, description: proj.problem, action: 'browse' });
  }
  const prosProject = !!folder && fs.existsSync(path.join(folder, 'project.pros'));
  if (prosProject && await onPath('pros')) {
    picks.push({ label: '$(cloud-upload) Upload this PROS project with the PROS CLI', action: 'pros',
      description: 'pros upload to the sim\'s serial port' });
  }
  // cargo-v5 finds a brain by its USB IDs (it takes no port): Windows USB only
  const rustProject = !!folder && isVexideCargo(diskFs.read(path.join(folder, 'Cargo.toml')) ?? '');
  if (rustProject && isWindows && await onPath('cargo-v5')) {
    picks.push({ label: '$(cloud-upload) Upload this Rust project with cargo v5', action: 'cargo',
      description: 'cargo v5 upload to the sim on Windows USB' });
  }
  const shown = new Set(picks.flatMap(p => p.program ? [p.program.file] : []));
  const bins = await vscode.workspace.findFiles('{build,bin}/**/*.bin', '**/node_modules/**', 30);
  bins.sort((a, b) => mtime(b.fsPath) - mtime(a.fsPath));
  for (const b of bins) {
    const name = path.basename(b.fsPath).toLowerCase();
    if (shown.has(b.fsPath) || name === 'hot.package.bin' || name === 'cold.package.bin') continue;
    picks.push({ label: `$(file-binary) ${vscode.workspace.asRelativePath(b)}`, action: 'program',
      program: { kind: 'bin', file: b.fsPath }, description: new Date(mtime(b.fsPath)).toLocaleString() });
  }
  picks.push({ label: '$(folder-opened) Choose a program (.bin, or a VEXcode Python .py)...', action: 'browse' });
  const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks,
    { placeHolder: 'What should the simulated brain run?' });
  if (!pick) return;

  const slot = await pickSlot(pick.slot);
  if (!slot) return;

  if (pick.action === 'pros') {
    await prosUpload(sim, folder!, slot);
    return;
  }
  if (pick.action === 'cargo') {
    await cargoUpload(sim, folder!, slot);
    return;
  }
  let program = pick.program;
  if (pick.action === 'browse') {
    const uri = await vscode.window.showOpenDialog({ filters: { 'V5 program': ['bin', 'py'] },
      defaultUri: folder ? vscode.Uri.file(folder) : undefined });
    if (!uri?.[0]) return;
    const r = programFor(uri[0].fsPath);
    if (!r.program) { void vscode.window.showWarningMessage(`Can't run ${path.basename(uri[0].fsPath)} on the simulator: ${r.problem}.`); return; }
    program = r.program;
  }
  if (program) await runOn(sim, program, slot);
}

/** Install the program in slot and start it: on the running simulator
 *  without a restart (its upload socket), else by (re)starting it with
 *  --run (and --link for a hot/cold pair or a Python program). A build
 *  older than its source is warned about first, unless it was just built
 *  (fresh: the after-build offer). */
export async function runOn(sim: SimInstance, given: Program, slot: number, opts: { fresh?: boolean } = {}): Promise<void> {
  const program = opts.fresh ? given : await upToDate(given, diskFs, vexSdk);
  if (!program) return;
  if (sim.state === 'running' && runLog) {
    const live = await runOnRunning(sim, program, slot, runLog);
    if (live === 'done') return;
    if (live === 'failed') {
      const restart = 'Restart with it', log = 'Show log';
      const pick = await vscode.window.showWarningMessage(
        `Couldn't install ${describe(program)} on the running simulator. Restart the simulator with it instead?`, restart, log);
      if (pick === log) runLog.show(true);
      if (pick !== restart) return;
    }
  }
  if (sim.state !== 'stopped' && !sim.owned) {
    const ok = await vscode.window.showWarningMessage(
      `Restart simulator instance ${sim.current?.id ?? ''} from VS Code to run ${describe(program)}?`,
      { modal: true }, 'Restart');
    if (ok !== 'Restart') return;
  }
  // --run installs it on a fresh copy of the brain's storage and starts it;
  // programs uploaded earlier stay on the brain's own storage
  await sim.restart({ program: program.file, slot, link: program.kind === 'bin' ? undefined : program.link });
}

/** A file as it runs (a hot/cold half runs its pair). */
export async function runBin(sim: SimInstance, file: string, slot: number): Promise<void> {
  const { program, problem } = programFor(file);
  if (!program) { void vscode.window.showWarningMessage(`Can't run ${path.basename(file)} on the simulator: ${problem}.`); return; }
  await runOn(sim, program, slot);
}

async function pickSlot(preferred?: number): Promise<number | undefined> {
  const def = preferred ?? slotSetting();
  const items = Array.from({ length: 8 }, (_, i) => ({ label: `Slot ${i + 1}`, slot: i + 1,
    picked: i + 1 === def }));
  items.unshift(items.splice(def - 1, 1)[0]);
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Program slot' });
  return pick?.slot;
}

async function running(sim: SimInstance): Promise<Running | undefined> {
  if (sim.state === 'stopped') {
    const go = await vscode.window.showInformationMessage('Start the simulator first?', 'Start');
    if (go !== 'Start') return undefined;
    await sim.start();
    await new Promise<void>(resolve => {
      const d = sim.onDidChange(() => { if (sim.state !== 'starting') { d.dispose(); resolve(); } });
      if (sim.state !== 'starting') { d.dispose(); resolve(); }
    });
  }
  return sim.target();
}

/** Windows, but the brain is on WSL serial ports (no usbip-win2, a brain
 *  already on Windows USB, or v5sim.usb = pty): Windows programs can't open
 *  them. An instance started elsewhere has neither, and is taken to be on USB. */
function onWslSerial(target: Running): boolean {
  return isWindows && !!target.ttySys && target.usbipPort === undefined;
}

/** The brain is on WSL serial ports, so a Windows uploader can't reach it:
 *  say so (and offer the USB driver). True when it said so. */
async function refusedOnWslSerial(target: Running, tool: string): Promise<boolean> {
  if (!onWslSerial(target)) return false;
  const install = 'Install USB driver';
  const pick = await vscode.window.showWarningMessage(
    `The simulated brain isn't on Windows USB (its USB port is a WSL serial port), so ${tool} on Windows can't reach it. ` +
    `Install the USB driver (usbip-win2) and restart the simulator, or run the project's build with "Run Program on Sim".`,
    install);
  if (pick === install) await installUsbDriver();
  return true;
}

async function prosUpload(sim: SimInstance, folder: string, slot: number): Promise<void> {
  const target = await running(sim);
  if (!target || await refusedOnWslSerial(target, 'the PROS CLI')) return;
  // With usbip-win2 the sim is a USB brain on Windows and pros finds it;
  // otherwise name its serial port.
  const port = !isWindows && target.ttySys ? ` ${target.ttySys}` : '';
  const term = vscode.window.createTerminal({ name: `PROS upload (sim ${target.id})`, cwd: folder, env: terminalEnv() });
  term.show();
  term.sendText(`pros upload --slot ${slot} --after run .${port}`);
}

/** cargo v5 upload (it builds first) to the sim on Windows USB. */
async function cargoUpload(sim: SimInstance, folder: string, slot: number): Promise<void> {
  const target = await running(sim);
  if (!target || await refusedOnWslSerial(target, 'cargo-v5')) return;
  const term = vscode.window.createTerminal({ name: `cargo v5 upload (sim ${target.id})`, cwd: folder, env: terminalEnv() });
  term.show();
  term.sendText(`cargo v5 upload --slot ${slot} --after run`);
}

/** The program's output: pros terminal (or screen) on the sim's user port. */
export async function programTerminal(sim: SimInstance): Promise<void> {
  const target = await running(sim);
  if (!target) return;
  if (onWslSerial(target) && target.ttyUser) {
    // the port is in WSL: open it there (pros terminal, else screen)
    const runner = await sim.runner();
    if (!runner) return;
    const tty = sh(target.ttyUser);
    const script = `if command -v pros >/dev/null; then exec pros terminal ${tty}; ` +
      `elif command -v screen >/dev/null; then exec screen ${tty}; ` +
      `else echo "Neither pros nor screen is installed in WSL (${runner.distro}): install one (sudo apt install screen), then try again."; read -r _; fi`;
    const term = vscode.window.createTerminal({ name: `V5 program (sim ${target.id})`, shellPath: 'wsl.exe',
      shellArgs: ['-d', runner.distro, '-e', 'bash', '-lc', script] });
    term.show();
    return;
  }
  if (isWindows || !target.ttyUser) {
    vscode.window.showInformationMessage(
      'This simulator is on Windows USB: open its User port with `pros terminal` or V5Term from the v5-simulacrum folder.');
    return;
  }
  const term = vscode.window.createTerminal({ name: `V5 program (sim ${target.id})`, env: terminalEnv() });
  term.show();
  term.sendText(await onPath('pros') ? `pros terminal ${target.ttyUser}` : `screen ${target.ttyUser}`);
}

function mtime(f: string): number {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}
