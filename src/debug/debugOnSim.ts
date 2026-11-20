// Debug on Sim: F5 (a "v5sim" launch configuration) or the command. Puts
// a v5gdb program (vexide or PROS) on the simulated brain with the GDB
// bridge on (v5brain.sh --gdb), then hands VS Code a GDB configuration for
// the C/C++ extension (or Native Debug) that connects to it. The program's
// output shows in a terminal meanwhile.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { upToDate } from '../buildFirst';
import { runOnRunning } from '../liveUpload';
import { Program, project, projectRoot } from '../programs';
import { diskFs, vexSdkRoot } from '../runProgram';
import { onPath } from '../runner';
import { cfg, slotSetting } from '../settings';
import { SimInstance } from '../simInstance';
import { Debugger, DebugTarget, debugConfiguration, debugTarget, gdbCandidates, gdbInstallHint } from './debugTarget';
import { V5GDB_WIKI, addDependencyCommands, installSnippet, upgradeCommand, v5gdbInsertions } from './v5gdbSetup';

const START_TIMEOUT_MS = 2 * 60_000;
const PORT_TIMEOUT_MS = 60_000;
const DEBUGGERS: [string, Debugger][] = [['ms-vscode.cpptools', 'cppdbg'], ['anysphere.cpptools', 'cppdbg'], ['webfreak.debug', 'native-debug']];

let log: vscode.OutputChannel;
let storageParent: string;

export function initDebug(context: vscode.ExtensionContext, sim: SimInstance, out: vscode.OutputChannel): void {
  log = out;
  storageParent = path.dirname(context.globalStorageUri.fsPath);
  context.subscriptions.push(
    vscode.commands.registerCommand('v5sim.debugProgram', async (uri?: vscode.Uri) => {
      const config = await prepare(sim, uri?.fsPath);
      if (config) await vscode.debug.startDebugging(folderOf(String(config.cwd)), config as vscode.DebugConfiguration);
    }),
    vscode.debug.registerDebugConfigurationProvider('v5sim', {
      provideDebugConfigurations: () => [{ type: 'v5sim', request: 'launch', name: 'Debug on V5 Sim' }],
      // VS Code runs the C/C++ extension's resolver on what this returns
      // (its type is cppdbg): no debug adapter of our own
      resolveDebugConfiguration: async (folder, config) =>
        (await prepare(sim, typeof config.program === 'string' ? config.program : undefined,
          folder?.uri.fsPath, typeof config.slot === 'number' ? config.slot : undefined)) as vscode.DebugConfiguration | undefined,
    }),
  );
}

function folderOf(dir: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
}

/** Everything up to a debug configuration that connects; undefined when
 *  the user stopped or something is missing (they were told). */
async function prepare(sim: SimInstance, given?: string, folder?: string, givenSlot?: number): Promise<Record<string, unknown> | undefined> {
  const root = await pickProject(given, folder);
  if (!root) return undefined;
  const proj = project(root, diskFs, vexSdkRoot());
  if (!proj?.program) {
    void vscode.window.showWarningMessage(`Can't debug ${path.basename(root)}: ${proj?.problem ?? "it isn't a PROS or vexide project"}.`);
    return undefined;
  }
  const program = await upToDate(proj.program, diskFs, vexSdkRoot());
  if (!program) return undefined;
  const found = debugTarget(root, program, diskFs);
  if ('problem' in found) {
    void vscode.window.showWarningMessage(`Can't debug ${path.basename(root)}: ${found.problem}.`);
    return undefined;
  }
  const t = found.target;
  if (t.tooOld) {
    void vscode.window.showWarningMessage(`v5gdb needs a newer ${t.framework === 'pros' ? 'PROS kernel' : 'vexide'} than ` +
      `${path.basename(root)} has (${t.version}). Upgrade it first: ${upgradeCommand(t.framework)}.`);
    return undefined;
  }
  if (!t.usesV5gdb) {
    await offerAddV5gdb(root, t);
    return undefined;
  }
  const gdb = await findGdb();
  if (!gdb) return undefined;
  const via = await debuggerExtension();
  if (!via) return undefined;
  const slot = givenSlot ?? proj.slot ?? slotSetting();
  const port = await simWithGdb(sim, program, slot);
  if (!port) return undefined;
  showOutput(port + 1, `V5 program (debug, ${path.basename(root)})`);
  return debugConfiguration(t, { name: `V5 Sim: ${proj.label}`, gdb, port, cwd: root, via });
}

/** The project to debug: the one given (a folder or a file in it), the
 *  open editor's, else the workspace's PROS or vexide projects (asked). */
async function pickProject(given?: string, folder?: string): Promise<string | undefined> {
  const rootOf = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory()
    ? (projectRoot(path.join(p, 'x'), diskFs) ?? undefined) : projectRoot(p, diskFs);
  if (given) {
    const r = rootOf(path.resolve(folder ?? '', given));
    if (!r) void vscode.window.showWarningMessage(`${given} isn't in a PROS or vexide project.`);
    return r;
  }
  const editor = vscode.window.activeTextEditor?.document.uri;
  const fromEditor = editor?.scheme === 'file' ? projectRoot(editor.fsPath, diskFs) : undefined;
  if (fromEditor) return fromEditor;
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => projectRoot(path.join(f.uri.fsPath, 'x'), diskFs))
    .filter((r): r is string => !!r);
  if (folder) {
    const r = projectRoot(path.join(folder, 'x'), diskFs);
    if (r) return r;
  }
  if (roots.length <= 1) {
    if (!roots.length) void vscode.window.showWarningMessage('Open a PROS or vexide (Rust) project to debug it on the simulator.');
    return roots[0];
  }
  const pick = await vscode.window.showQuickPick(roots.map(r => ({ label: path.basename(r), description: r, r })),
    { placeHolder: 'Which project?' });
  return pick?.r;
}

/** Warn first, then add v5gdb: the dependency in a terminal (seen run),
 *  the install call through VS Code's preview (nothing written until
 *  applied). The project then needs a build. */
async function offerAddV5gdb(root: string, t: DebugTarget): Promise<void> {
  const add = 'Add v5gdb', how = 'Show me how';
  const pick = await vscode.window.showWarningMessage(
    `${path.basename(root)} doesn't use v5gdb, which Debug on Sim needs (a debugger built into the program). Add it?`, add, how);
  if (pick === how) void vscode.env.openExternal(vscode.Uri.parse(V5GDB_WIKI[t.framework]));
  if (pick !== add) return;
  const term = vscode.window.createTerminal({ name: 'Add v5gdb', cwd: root });
  term.show();
  // one command per line: Windows PowerShell 5 has no &&
  for (const c of addDependencyCommands(t.framework, false)) term.sendText(c);
  const entry = path.join(root, 'src', t.framework === 'vexide' ? 'main.rs' : 'main.cpp');
  const text = diskFs.read(entry);
  const ins = text === undefined ? undefined : v5gdbInsertions(t.framework, text);
  if (!ins) {
    const doc = await vscode.workspace.openTextDocument({ content: installSnippet(t.framework), language: t.framework === 'vexide' ? 'rust' : 'cpp' });
    await vscode.window.showTextDocument(doc, { preview: true });
    void vscode.window.showInformationMessage(`Couldn't find where v5gdb's install call goes in ${path.relative(root, entry)}: paste these lines (shown), build, then debug again.`);
    return;
  }
  if (ins.length) {
    const edit = new vscode.WorkspaceEdit();
    const meta = { needsConfirmation: true, label: 'Add v5gdb', description: path.relative(root, entry) };
    const uri = vscode.Uri.file(entry);
    for (const i of ins) edit.insert(uri, new vscode.Position(i.line, 0), `${i.text}\n`, meta);
    await vscode.workspace.applyEdit(edit);
  }
  void vscode.window.showInformationMessage('Once the dependency is added and the change applied, build the project and run Debug on Sim again.');
}

/** GDB on this machine: v5sim.gdbPath, the PROS toolchain's, or PATH. */
async function findGdb(): Promise<string | undefined> {
  for (const c of gdbCandidates(process.platform, storageParent, cfg().get<string>('gdbPath'))) {
    if (path.isAbsolute(c) ? fs.existsSync(c) : await onPath(c)) return c;
  }
  const setting = 'Set v5sim.gdbPath';
  const pick = await vscode.window.showWarningMessage(
    `Debug on Sim needs GDB with ARM support, and none was found: ${gdbInstallHint(process.platform)}.`, setting);
  if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'v5sim.gdbPath');
  return undefined;
}

/** The extension that runs GDB: Microsoft's C/C++ (or Cursor's), else
 *  Native Debug (VSCodium); offers to install C/C++ when neither is there. */
async function debuggerExtension(): Promise<Debugger | undefined> {
  for (const [id, via] of DEBUGGERS) if (vscode.extensions.getExtension(id)) return via;
  const install = 'Install C/C++';
  const pick = await vscode.window.showWarningMessage(
    'Debug on Sim runs GDB through the C/C++ extension (ms-vscode.cpptools), or Native Debug (webfreak.debug). Install one, then try again.', install);
  if (pick) await vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.cpptools');
  return undefined;
}

/** The program running on a simulator with the GDB bridge: installed on
 *  the running one when it has the bridge, else (re)started with --gdb.
 *  Returns the GDB port once it answers. */
async function simWithGdb(sim: SimInstance, program: Program, slot: number): Promise<number | undefined> {
  if (sim.state === 'running' && sim.current?.gdbPort) {
    const r = await runOnRunning(sim, program, slot, log);
    if (r !== 'done') {
      void vscode.window.showWarningMessage("Couldn't install the program on the running simulator: see the V5 Sim log.");
      return undefined;
    }
  } else {
    if (sim.state !== 'stopped' && !sim.owned) {
      const ok = await vscode.window.showWarningMessage(
        `Restart simulator instance ${sim.current?.id ?? ''} from VS Code, with the debugger bridge, to debug this program?`,
        { modal: true }, 'Restart');
      if (ok !== 'Restart') return undefined;
    }
    await sim.restart({ program: program.file, slot, link: program.kind === 'bin' ? undefined : program.link, gdb: true });
    await untilSettled(sim);
  }
  const port = sim.state === 'running' ? sim.current?.gdbPort : undefined;
  if (!port) {
    void vscode.window.showWarningMessage(
      "The simulator didn't start its debugger bridge (an older simulator?): see the V5 Sim log.");
    return undefined;
  }
  // the output port answers once the bridge listens (probing GDB's port
  // would take the bridge's one GDB connection)
  if (!await portOpen(port + 1, PORT_TIMEOUT_MS)) {
    void vscode.window.showWarningMessage(`The debugger bridge isn't answering on port ${port}: see the V5 Sim log.`);
    return undefined;
  }
  return port;
}

function untilSettled(sim: SimInstance): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); d.dispose(); resolve(); };
    const t = setTimeout(done, START_TIMEOUT_MS);
    const d = sim.onDidChange(() => { if (sim.state === 'running' || sim.state === 'stopped') done(); });
    if (sim.state === 'running' || sim.state === 'stopped') done();
  });
}

async function portOpen(port: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(2_000, () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** The program's output (the bridge's text port) in a terminal, until the
 *  simulator closes it. */
function showOutput(port: number, name: string): void {
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<void>();
  let sock: net.Socket | undefined;
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      sock = net.connect({ host: '127.0.0.1', port });
      sock.setEncoding('utf8');
      sock.on('data', (d: string) => write.fire(d.replace(/\r?\n/g, '\r\n')));
      sock.on('error', e => write.fire(`\r\n[V5 Sim: no program output: ${e.message}]\r\n`));
      sock.on('close', () => write.fire('\r\n[V5 Sim: the simulator closed the program output]\r\n'));
    },
    close: () => sock?.destroy(),
    handleInput: () => write.fire('\r\n[V5 Sim: while debugging, input goes to GDB, not the program]\r\n'),
  };
  vscode.window.createTerminal({ name, pty }).show(true);
}
