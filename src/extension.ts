import * as vscode from 'vscode';

import { FeedbackPanel } from './feedback/feedbackPanel';
import { LogBuffer, teeLog } from './feedback/logBuffer';
import { PortsPanel } from './panels/portsPanel';
import { Page, WebPanel } from './panels/webPanel';
import { initPrograms, programTerminal, runEditorProgram, runProgram } from './runProgram';
import { initRunOnSim } from './runOnSim';
import { initDebug } from './debug/debugOnSim';
import { quietWhenClosed } from './safeLog';
import { initRuntime, simRunner } from './runtime';
import { cfg } from './settings';
import { SimInstance } from './simInstance';
import { initUsbDriver, installUsbDriver } from './usbDriver';
import { initErrorReporting, reporting } from './errors/errorReporting';

let sim: SimInstance | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // teed so a feedback report can include it (output channels can't be read)
  const logBuffer = new LogBuffer();
  const log = teeLog(quietWhenClosed(vscode.window.createOutputChannel('V5 Sim')), logBuffer);
  initErrorReporting(context, logBuffer);
  initRuntime(context, log);
  initUsbDriver(context);
  sim = new SimInstance(log);
  const s = sim;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'v5sim.menu';
  const showStatus = () => {
    const id = s.current ? ` ${s.current.id}` : '';
    status.text = {
      stopped: '$(circle-outline) V5 Sim',
      starting: '$(loading~spin) V5 Sim starting',
      running: `$(vm-running) V5 Sim${id}`,
      stopping: '$(loading~spin) V5 Sim stopping',
    }[s.state];
    status.tooltip = s.current
      ? `Simulator instance ${s.current.id}: http://localhost:${s.current.viewPort}/`
      : 'V5 brain simulator';
    status.show();
  };
  showStatus();

  let wasRunning = false;
  s.onDidChange(() => {
    showStatus();
    WebPanel.refreshAll(s.state === 'running' ? s.current : s.state === 'starting' ? 'starting' : undefined);
    if (s.state === 'running' && !wasRunning && s.owned && cfg().get('openBrainOnStart', true)) {
      WebPanel.show('screen', s.current);
    }
    wasRunning = s.state === 'running';
  });

  // An instance started elsewhere that stopped answering: forget it once
  // v5fleet.sh no longer lists it, so Start works again.
  WebPanel.onPageDown = target => {
    if (s.owned || s.current !== target) return;
    void s.list().then(up => { if (s.current === target && !up.some(r => r.id === target.id)) s.detach(); });
  };

  const open = (page: Page) => async () => {
    const target = await s.target();
    if (target) WebPanel.show(page, target);
  };

  const commands: Record<string, (...args: any[]) => unknown> = {
    'v5sim.start': () => s.start(),
    'v5sim.stop': () => s.state === 'stopped'
      ? vscode.window.showInformationMessage('No simulator started from VS Code is running.')
      : s.stop(),
    'v5sim.restart': () => s.restart(),
    'v5sim.openBrain': open('screen'),
    'v5sim.openDashboard': open('dashboard'),
    'v5sim.openField': open(''),
    'v5sim.openController': open('controller'),
    'v5sim.configurePorts': (uri?: vscode.Uri) => {
      const file = uri instanceof vscode.Uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
      return PortsPanel.open(context, s, file?.endsWith('.args') ? file : undefined);
    },
    'v5sim.showLog': () => log.show(),
    'v5sim.reportIssue': () => FeedbackPanel.open({ context, sim: s, log: logBuffer }),
    'v5sim.repair': async () => {
      if (s.state !== 'stopped') await s.stop();
      if (await simRunner(true)) vscode.window.showInformationMessage('The V5 simulator is set up.');
    },
    'v5sim.installUsbDriver': () => installUsbDriver(),
    'v5sim.runProgram': (uri?: vscode.Uri) => reporting('run-on-sim', "Couldn't run the program on the simulator",
      () => runProgram(s, uri instanceof vscode.Uri ? uri.fsPath : undefined)),
    'v5sim.runEditorProgram': (uri?: vscode.Uri) => reporting('run-on-sim', "Couldn't run the project on the simulator",
      () => runEditorProgram(s, uri instanceof vscode.Uri ? uri.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath)),
    'v5sim.programTerminal': () => programTerminal(s),
    'v5sim.menu': async () => {
      const running = s.state === 'running';
      const items: (vscode.QuickPickItem & { cmd: string })[] = [
        ...(running ? [] : [{ label: '$(play) Start', cmd: 'v5sim.start' }]),
        ...(running ? [{ label: '$(debug-stop) Stop', cmd: 'v5sim.stop' },
                       { label: '$(debug-restart) Restart', cmd: 'v5sim.restart' }] : []),
        { label: '$(device-desktop) Brain screen', cmd: 'v5sim.openBrain' },
        { label: '$(dashboard) Device dashboard', cmd: 'v5sim.openDashboard' },
        { label: '$(map) Field view', cmd: 'v5sim.openField' },
        { label: '$(game) Controller', cmd: 'v5sim.openController' },
        { label: '$(run) Run program on sim', cmd: 'v5sim.runProgram' },
        { label: '$(terminal) Program terminal', cmd: 'v5sim.programTerminal' },
        { label: '$(plug) Configure ports', cmd: 'v5sim.configurePorts',
          description: cfg().get<string>('preset', '') },
        { label: '$(output) Log', cmd: 'v5sim.showLog' },
        { label: '$(feedback) Report a problem / send feedback', cmd: 'v5sim.reportIssue' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'V5 brain simulator' });
      if (pick) await vscode.commands.executeCommand(pick.cmd);
    },
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }
  context.subscriptions.push(log, status, s);
  initPrograms(context, log);
  initRunOnSim(context, s, log);
  initDebug(context, s, log);

  // the activity-bar view: its welcome content holds the buttons
  context.subscriptions.push(vscode.window.registerTreeDataProvider('v5sim.home', {
    getChildren: () => [],
    getTreeItem: (item: vscode.TreeItem) => item,
  }));

  // once after installing: say it's there and offer to start it
  if (!context.globalState.get<boolean>('v5sim.welcomed')) {
    void context.globalState.update('v5sim.welcomed', true);
    void vscode.window.showInformationMessage(
      'V5 Brain Simulator is installed. Start it now? (It\'s also under the V5 Sim icon in the activity bar.)',
      'Start', 'Later').then(pick => {
      if (pick === 'Start') void vscode.commands.executeCommand('v5sim.start');
    });
  }
}

/** VS Code is closing: stop our simulator gracefully (never killed). */
export async function deactivate(): Promise<void> {
  if (sim?.owned) await sim.stop();
}
