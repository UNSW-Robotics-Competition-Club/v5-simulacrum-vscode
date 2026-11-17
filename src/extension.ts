import * as vscode from 'vscode';

import { PortsPanel } from './panels/portsPanel';
import { Page, WebPanel } from './panels/webPanel';
import { programTerminal, runProgram } from './runProgram';
import { initRuntime, simRunner } from './runtime';
import { cfg } from './settings';
import { SimInstance } from './simInstance';

let sim: SimInstance | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('V5 Sim');
  initRuntime(context, log);
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
    void vscode.commands.executeCommand('setContext', 'v5sim.running', s.state === 'running');
    WebPanel.refreshAll(s.state === 'running' ? s.current : undefined);
    if (s.state === 'running' && !wasRunning && s.owned && cfg().get('openBrainOnStart', true)) {
      WebPanel.show('screen', s.current);
    }
    wasRunning = s.state === 'running';
  });

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
    'v5sim.configurePorts': (uri?: vscode.Uri) => {
      const file = uri instanceof vscode.Uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
      return PortsPanel.open(context, s, file?.endsWith('.args') ? file : undefined);
    },
    'v5sim.showLog': () => log.show(),
    'v5sim.repair': async () => {
      if (s.state !== 'stopped') await s.stop();
      if (await simRunner(true)) vscode.window.showInformationMessage('The V5 simulator is set up.');
    },
    'v5sim.runProgram': (uri?: vscode.Uri) => runProgram(s, uri instanceof vscode.Uri ? uri.fsPath : undefined),
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
        { label: '$(run) Run program on sim', cmd: 'v5sim.runProgram' },
        { label: '$(terminal) Program terminal', cmd: 'v5sim.programTerminal' },
        { label: '$(plug) Configure ports', cmd: 'v5sim.configurePorts',
          description: cfg().get<string>('preset', '') },
        { label: '$(output) Log', cmd: 'v5sim.showLog' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'V5 brain simulator' });
      if (pick) await vscode.commands.executeCommand(pick.cmd);
    },
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }
  context.subscriptions.push(log, status, s);

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
