// "Run on Sim" where Mac users look for VEXcode's Download button, which
// can't see the simulated brain on a Mac (no USB device there, only serial
// ports): a status bar button, a button in VEX projects' editor title, an
// offer to run each new build, and a one-time tip.
import * as vscode from 'vscode';

import { buildAction, isProgramBuild } from './buildWatch';
import { Program, describe, isVexideCargo, project, projectRoot } from './programs';
import { diskFs, runOn, vexSdkRoot } from './runProgram';
import { isMac, isWindows, usbipExe } from './runner';
import { cfg, slotSetting } from './settings';
import { SimInstance } from './simInstance';
import { reporting } from './errors/errorReporting';

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
    button.tooltip = "Install and run a program on the simulated brain: a .bin, a PROS project (hot/cold too), a VEXcode Python project, a Rust (vexide) project. On a Mac, VEXcode's Download button can't see the simulator.";
    button.command = 'v5sim.runProgram';
    button.show();
    context.subscriptions.push(button);
    context.subscriptions.push(sim.onDidChange(() => {
      if (sim.state === 'running') void macTip(context);
    }));
  }

  // one offer per build: a PROS build writes its hot and cold packages (and
  // more), so builds in a project are keyed by the project
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const built = (uri: vscode.Uri) => {
    const file = uri.fsPath;
    const root = projectRoot(file, diskFs);
    if (!root && !isProgramBuild(file)) return;
    const key = root ?? file;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      log?.appendLine(`[v5sim] new build: ${file}`);
      void reporting('run-on-sim', "Couldn't run the new build on the simulator", () => offerBuild(sim, file, root));
    }, SETTLE_MS));
  };
  // VEXcode and PROS builds; cargo-v5's (Rust) in target/<triple>/<profile>/
  const watchers = ['**/{build,bin}/*.bin', '**/target/*-vex-v5/*/*.bin'].map(g => vscode.workspace.createFileSystemWatcher(g));
  log?.appendLine('[v5sim] watching for builds (build/*.bin, bin/*.bin, target/*-vex-v5/*/*.bin) to offer Run on Sim');
  for (const w of watchers) context.subscriptions.push(w, w.onDidCreate(built), w.onDidChange(built));
  context.subscriptions.push({ dispose: () => timers.forEach(t => clearTimeout(t)) });
}

/** v5sim.vexProject / v5sim.rustProject: a VEXcode or vexide project is
 *  open (the editor-title Run on Sim button). */
async function markVexProject(): Promise<void> {
  const found = await vscode.workspace.findFiles('**/.vscode/vex_project_settings.json', '**/node_modules/**', 1);
  await vscode.commands.executeCommand('setContext', 'v5sim.vexProject', found.length > 0);
  const cargo = await vscode.workspace.findFiles('**/Cargo.toml', '**/{node_modules,target}/**', 20);
  const rust = cargo.some(u => isVexideCargo(diskFs.read(u.fsPath) ?? ''));
  await vscode.commands.executeCommand('setContext', 'v5sim.rustProject', rust);
}

/** A build just wrote a program: run it on the sim, or offer to. In a PROS
 *  or VEXcode project, what the project runs (a hot/cold pair, in its slot). */
async function offerBuild(sim: SimInstance, file: string, root: string | undefined): Promise<void> {
  let program: Program = { kind: 'bin', file };
  let slot = slotSetting();
  if (root) {
    const proj = project(root, diskFs, vexSdkRoot());
    if (!proj?.program) {
      log?.appendLine(`[v5sim]   not offered: ${proj?.problem ?? 'not a program'}`);
      return;
    }
    program = proj.program;
    slot = proj.slot ?? slot;
  }
  const action = buildAction(cfg().get<string>('runOnBuild', 'ask'),
    { isMac, windowsUsb: isWindows && !!usbipExe() });
  if (action === 'none') {
    log?.appendLine('[v5sim]   not offered: ' + (isWindows && usbipExe()
      ? "the brain is on Windows USB (VEXcode's Download reaches it)" : 'v5sim.runOnBuild is "never"'));
    return;
  }
  if (action === 'run') {
    log?.appendLine('[v5sim]   running it (v5sim.runOnBuild is "always")');
    await runNewest(sim, program, slot);
    return;
  }
  const key = root ?? file;
  if (offers.has(key)) {
    // one offer per project: the open one runs this newer build if accepted
    offers.set(key, { program, slot });
    log?.appendLine('[v5sim]   an offer is already open: it will run this build');
    return;
  }
  log?.appendLine('[v5sim]   offering Run on Sim');
  offers.set(key, { program, slot });
  try {
    const run = 'Run on Sim', always = 'Always', never = "Don't ask";
    const pick = await vscode.window.showInformationMessage(
      `New build: ${describe(program)}. Run it on the simulated brain (slot ${slot})?`, run, always, never);
    if (pick === always) await cfg().update('runOnBuild', 'always', vscode.ConfigurationTarget.Global);
    if (pick === never) {
      await cfg().update('runOnBuild', 'never', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        'Builds won\'t offer to run on the simulator. Use "V5 Sim: Run Program on Sim", or set v5sim.runOnBuild.');
      return;
    }
    const newest = offers.get(key)!;
    if (pick === run || pick === always) await runNewest(sim, newest.program, newest.slot);
  } finally {
    offers.delete(key);
  }
}

/** Open offers, by project (or file): the newest build each would run. */
const offers = new Map<string, { program: Program; slot: number }>();

let running: Promise<void> | undefined;
let queued: (() => Promise<void>) | undefined;

/** One run at a time: a build that lands while one is starting replaces
 *  any other waiting, so only the newest runs next (no overlapping
 *  restarts, no "already starting"). */
function runNewest(sim: SimInstance, program: Program, slot: number): Promise<void> {
  const go = () => runOn(sim, program, slot);
  if (running) {
    queued = go;
    return running;
  }
  running = (async () => {
    try {
      await go();
      while (queued) {
        const next = queued;
        queued = undefined;
        await next();
      }
    } finally {
      running = undefined;
    }
  })();
  return running;
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
