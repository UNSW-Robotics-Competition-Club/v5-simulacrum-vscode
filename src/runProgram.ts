// Getting a program onto the simulated brain where VEXcode's Download button
// can't see it (macOS, or WSL without usbip-win2):
// - a .bin (VEXcode C++, plain C, vexide): (re)start the sim with --run, which
//   installs it in a slot and starts it;
// - a PROS project: `pros upload` to the sim's serial port, in a terminal.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { isWindows, onPath, sh, terminalEnv } from './runner';
import { installUsbDriver } from './usbDriver';
import { slotSetting } from './settings';
import { Running, SimInstance } from './simInstance';

type Pick = vscode.QuickPickItem & { action: 'bin' | 'pros' | 'browse'; file?: string };

export async function runProgram(sim: SimInstance, given?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (given) {                         // from the explorer: that .bin
    const slot = await pickSlot();
    if (slot) await runBin(sim, given, slot);
    return;
  }
  const picks: Pick[] = [];
  const prosProject = !!folder && fs.existsSync(path.join(folder, 'project.pros'));
  if (prosProject && await onPath('pros')) {
    picks.push({ label: '$(cloud-upload) Upload this PROS project with the PROS CLI', action: 'pros',
      description: 'pros upload to the sim\'s serial port' });
  }
  const bins = await vscode.workspace.findFiles('{build,bin}/**/*.bin', '**/node_modules/**', 30);
  bins.sort((a, b) => mtime(b.fsPath) - mtime(a.fsPath));
  for (const b of bins) {
    picks.push({ label: `$(file-binary) ${vscode.workspace.asRelativePath(b)}`, action: 'bin', file: b.fsPath,
      description: new Date(mtime(b.fsPath)).toLocaleString() });
  }
  picks.push({ label: '$(folder-opened) Choose a .bin...', action: 'browse' });
  const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks,
    { placeHolder: 'What should the simulated brain run?' });
  if (!pick) return;

  const slot = await pickSlot();
  if (!slot) return;

  if (pick.action === 'pros') {
    await prosUpload(sim, folder!, slot);
    return;
  }
  let file = pick.file;
  if (pick.action === 'browse') {
    const uri = await vscode.window.showOpenDialog({ filters: { 'V5 program': ['bin'] },
      defaultUri: folder ? vscode.Uri.file(folder) : undefined });
    file = uri?.[0]?.fsPath;
  }
  if (!file) return;
  await runBin(sim, file, slot);
}

/** Install file in slot and start it: the sim restarts with --run. */
export async function runBin(sim: SimInstance, file: string, slot: number): Promise<void> {
  if (sim.state !== 'stopped' && !sim.owned) {
    const ok = await vscode.window.showWarningMessage(
      `Restart simulator instance ${sim.current?.id ?? ''} from VS Code to run ${path.basename(file)}?`,
      { modal: true }, 'Restart');
    if (ok !== 'Restart') return;
  }
  // --run installs it on a fresh copy of the brain's storage and starts it;
  // programs uploaded earlier stay on the brain's own storage
  await sim.restart({ program: file, slot });
}

async function pickSlot(): Promise<number | undefined> {
  const def = slotSetting();
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

async function prosUpload(sim: SimInstance, folder: string, slot: number): Promise<void> {
  const target = await running(sim);
  if (!target) return;
  if (onWslSerial(target)) {
    const install = 'Install USB driver';
    const pick = await vscode.window.showWarningMessage(
      "The simulated brain isn't on Windows USB (its USB port is a WSL serial port), so the PROS CLI on Windows can't reach it. " +
      `Install the USB driver (usbip-win2) and restart the simulator, or run the project's .bin (bin/monolith.bin) with "Run Program on Sim".`,
      install);
    if (pick === install) await installUsbDriver();
    return;
  }
  // With usbip-win2 the sim is a USB brain on Windows and pros finds it;
  // otherwise name its serial port.
  const port = !isWindows && target.ttySys ? ` ${target.ttySys}` : '';
  const term = vscode.window.createTerminal({ name: `PROS upload (sim ${target.id})`, cwd: folder, env: terminalEnv() });
  term.show();
  term.sendText(`pros upload --slot ${slot} --after run .${port}`);
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
