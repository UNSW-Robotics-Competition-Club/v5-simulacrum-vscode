// "Run on Sim" where Mac users look for VEXcode's Download button, which
// can't see the simulated brain on a Mac (no USB device there, only serial
// ports): a status bar button, a button in VEX projects' editor title, an
// offer to run each new build, and a one-time tip.
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildAction, isProgramBuild } from './buildWatch';
import { runBin } from './runProgram';
import { isMac, isWindows, usbipExe } from './runner';
import { cfg, slotSetting } from './settings';
import { SimInstance } from './simInstance';

const TIP_KEY = 'v5sim.macRunTipShown';
/** A build writes its .bin more than once: offer once it has settled. */
const SETTLE_MS = 1_500;

let log: vscode.OutputChannel | undefined;

export function initRunOnSim(context: vscode.ExtensionContext, sim: SimInstance, out: vscode.OutputChannel): void {
  log = out;
  void markVexProject();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void markVexProject()));

  if (isMac) {
    const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    button.text = '$(run) Run on Sim';
    button.tooltip = "Install and run a program (.bin) on the simulated brain. On a Mac, VEXcode's Download button can't see the simulator.";
    button.command = 'v5sim.runProgram';
    button.show();
    context.subscriptions.push(button);
    context.subscriptions.push(sim.onDidChange(() => {
      if (sim.state === 'running') void macTip(context);
    }));
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const built = (uri: vscode.Uri) => {
    if (!isProgramBuild(uri.fsPath)) return;
    clearTimeout(timers.get(uri.fsPath));
    timers.set(uri.fsPath, setTimeout(() => {
      timers.delete(uri.fsPath);
      log?.appendLine(`[v5sim] new build: ${uri.fsPath}`);
      void offerRun(sim, uri.fsPath);
    }, SETTLE_MS));
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/{build,bin}/*.bin');
  log?.appendLine('[v5sim] watching for builds (build/*.bin, bin/*.bin) to offer Run on Sim');
  context.subscriptions.push(watcher, watcher.onDidCreate(built), watcher.onDidChange(built),
    { dispose: () => timers.forEach(t => clearTimeout(t)) });
}

/** v5sim.vexProject: a VEXcode project is open (its editor-title button). */
async function markVexProject(): Promise<void> {
  const found = await vscode.workspace.findFiles('**/.vscode/vex_project_settings.json', '**/node_modules/**', 1);
  await vscode.commands.executeCommand('setContext', 'v5sim.vexProject', found.length > 0);
}

/** A build just wrote a program: run it on the sim, or offer to. */
async function offerRun(sim: SimInstance, file: string): Promise<void> {
  const action = buildAction(cfg().get<string>('runOnBuild', 'ask'),
    { isMac, windowsUsb: isWindows && !!usbipExe() });
  if (action === 'none') {
    log?.appendLine('[v5sim]   not offered: ' + (isWindows && usbipExe()
      ? "the brain is on Windows USB (VEXcode's Download reaches it)" : 'v5sim.runOnBuild is "never"'));
    return;
  }
  log?.appendLine(`[v5sim]   ${action === 'run' ? 'running it (v5sim.runOnBuild is "always")' : 'offering Run on Sim'}`);
  const slot = slotSetting();
  if (action === 'run') {
    await runBin(sim, file, slot);
    return;
  }
  const run = 'Run on Sim', always = 'Always', never = "Don't ask";
  const pick = await vscode.window.showInformationMessage(
    `New build: ${path.basename(file)}. Run it on the simulated brain (slot ${slot})?`, run, always, never);
  if (pick === always) await cfg().update('runOnBuild', 'always', vscode.ConfigurationTarget.Global);
  if (pick === never) {
    await cfg().update('runOnBuild', 'never', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      'Builds won\'t offer to run on the simulator. Use "V5 Sim: Run Program on Sim", or set v5sim.runOnBuild.');
    return;
  }
  if (pick === run || pick === always) await runBin(sim, file, slot);
}

/** Once: why VEXcode's Download button doesn't see the simulator on a Mac. */
async function macTip(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(TIP_KEY)) return;
  await context.globalState.update(TIP_KEY, true);
  const run = 'Run on Sim';
  const pick = await vscode.window.showInformationMessage(
    "On a Mac, VEXcode's Download button can't see the simulated brain. Build as usual, then accept " +
    '"Run on Sim", or use the ▶ Run on Sim button in the status bar (or right-click a .bin).', run, 'OK');
  if (pick === run) await vscode.commands.executeCommand('v5sim.runProgram');
}
